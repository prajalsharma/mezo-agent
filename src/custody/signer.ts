import {
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type TransactionRequest,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { chainFor } from "../chain/networks.js";
import { publicClient } from "../chain/client.js";
import { store, type UserRecord, type SessionKey } from "../db/store.js";
import { sessionKeyDelegateAbi } from "../abis/delegate.js";
import { LocalKeyStore } from "./localKeystore.js";
import { limitsOf, fmtBtc, tokenCapOf, dailyTokenCapOf, DAILY_TOKEN_CAP_MULTIPLE, BTC_PRECOMPILE } from "./policy.js";
import { registry } from "../registry/registry.js";
import { isAttested } from "./attest.js";

/**
 * Signer — the isolated write path. Its only job is: "sign & submit this
 * operation IF it is within policy." It independently re-checks policy before
 * signing (defense in depth) and only ever touches the key inside the KeyStore
 * `use` callback, so no key material is exposed to the rest of the system.
 *
 * In production this runs as a separate process fronting a KMS/MPC signer; the
 * interface is identical.
 */

export type SignablePlan = {
  /** Already simulated and confirmed by the user. */
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Human policy metadata the signer re-validates. */
  policy: {
    /** Contracts the app intends to touch — signer rejects anything else. */
    allowedTargets: Address[];
    /** What this step moves, for cap enforcement. See AssetMove in surfaces/plan.ts. */
    erc20?: { symbol: string; amount: bigint; kind?: "spend" | "approval" };
  };
};

export class PolicyViolationError extends Error {}

// Lazy: a misconfigured master key surfaces via preflight/diag, not an
// import-time crash.
let _keystore: LocalKeyStore | undefined;
function keystore(): LocalKeyStore {
  return (_keystore ??= new LocalKeyStore());
}

/**
 * BTC (wei) this step actually moves. On Mezo BTC is spent through its ERC-20
 * precompile, so a BTC transfer carries `value: 0n` and the amount is in the
 * erc20 descriptor (symbol "BTC") or is a direct call to the precompile. We
 * count BOTH so the native caps bind on every BTC path, not just payable ones.
 * (Audit R2 C1.)
 */
function btcWeiMoved(plan: SignablePlan): bigint {
  let wei = plan.value ?? 0n;
  const e = plan.policy.erc20;
  if (e && (e.symbol === "BTC" || plan.to.toLowerCase() === BTC_PRECOMPILE.toLowerCase())) {
    wei += e.amount;
  }
  return wei;
}

/**
 * Is this an address the SIGNER is willing to touch, independent of what the
 * plan claims? Registry-known, the configured fee recipient, or an address a
 * builder verified on-chain this session (see custody/attest.ts).
 */
function isVettedTarget(owner: Address, to: Address): boolean {
  const a = to.toLowerCase();
  if (registry.knownAddresses().has(a)) return true;
  if (env.fees.recipient && a === env.fees.recipient.toLowerCase()) return true;
  // Per-user: one user's build must not widen anyone else's target set.
  return isAttested(owner, to);
}

/**
 * BTC (wei) this step commits against the ROLLING 24h budget.
 *
 * An approval and the transfer it enables are the same funds, so counting both
 * would charge a plan twice and lock users out of their own daily allowance. The
 * approval is still bounded by the per-transaction cap above — it just doesn't
 * consume the day's budget, because the spend that follows it will.
 */
function btcWeiSpent(plan: SignablePlan): bigint {
  if (plan.policy.erc20?.kind === "approval") return plan.value ?? 0n;
  return btcWeiMoved(plan);
}

function assertPolicy(user: UserRecord, plan: SignablePlan): void {
  if (user.mode === "watch-only") {
    throw new PolicyViolationError("Account is in watch-only mode; refusing to sign.");
  }
  const allowed = plan.policy.allowedTargets.map((a) => a.toLowerCase());
  if (!allowed.includes(plan.to.toLowerCase())) {
    throw new PolicyViolationError(
      `Target ${plan.to} is not in the allowlist for this action; refusing to sign.`,
    );
  }

  // AN INDEPENDENT CHECK, not the plan's own opinion of itself.
  //
  // The check above asks the plan whether the plan is allowed: `allowedTargets`
  // arrives inside the plan, so a builder that names a bad target also blesses
  // it. That is exactly the property this layer exists to provide and it was
  // the one thing it did not do — containment rested entirely on builder
  // correctness, with nothing verifying it at the signing boundary.
  //
  // So the signer now independently requires every target to be an address the
  // REGISTRY knows, or one a builder has separately validated on-chain (a gauge
  // whose stakingToken matches its pool, a reward contract read from the Voter).
  // A builder can still be wrong about which known contract to call; it can no
  // longer invent a destination.
  if (!isVettedTarget(user.address, plan.to)) {
    throw new PolicyViolationError(
      `Target ${plan.to} is not a known Mezo contract for this deployment; refusing to sign.`,
    );
  }

  const limits = limitsOf(user.limits);

  // BTC caps — measured on the BTC actually moved (native value + precompile
  // ERC-20), so lock/swap/zap/vault/stake are all bound, not just Trove ops.
  const btc = btcWeiMoved(plan);
  if (btc > 0n) {
    const perTx = BigInt(limits.perTxNativeWei);
    if (btc > perTx) {
      throw new PolicyViolationError(
        `Blocked: ${fmtBtc(btc)} exceeds the per-transaction limit of ${fmtBtc(perTx)}. Raise it with /limits.`,
      );
    }
    const daily = BigInt(limits.dailyNativeWei);
    const spent = store.spentLast24hWei(user.telegramId);
    const committing = btcWeiSpent(plan);
    if (spent + committing > daily) {
      throw new PolicyViolationError(
        `Blocked: this would put 24h spend at ${fmtBtc(spent + committing)}, over the daily ` +
          `limit of ${fmtBtc(daily)} (already spent ${fmtBtc(spent)}). Raise it with /limits.`,
      );
    }
  }

  // Per-token (non-BTC ERC-20) cap. tokenCapOf now always returns a value
  // (conservative default for unknown tokens), so this branch can no longer be
  // silently skipped (Audit R2 H8). BTC is handled by the native caps above.
  const e = plan.policy.erc20;
  if (e && e.symbol !== "BTC" && plan.to.toLowerCase() !== BTC_PRECOMPILE.toLowerCase()) {
    const cap = tokenCapOf(user.limits, e.symbol);
    if (e.amount > cap) {
      throw new PolicyViolationError(
        `Blocked: this moves more ${e.symbol} than your per-transaction cap for that token ` +
          `(${cap} raw). Raise it with "/limits token ${e.symbol} <amount>".`,
      );
    }
    // ROLLING 24h AGGREGATE. Without this, the per-tx cap bound each swap
    // individually and nothing bound the sequence — so an hourly DCA was
    // twenty-four separately-legal transactions adding up to twenty-four times
    // the cap, and no layer anywhere could see the total. Unattended automation
    // is precisely the case that needs the aggregate rather than the per-item
    // limit. Approvals don't consume it (the spend they enable will).
    if (e.kind !== "approval") {
      const dailyCap = dailyTokenCapOf(user.limits, e.symbol);
      const already = store.spentLast24hToken(user.telegramId, e.symbol);
      if (already + e.amount > dailyCap) {
        throw new PolicyViolationError(
          `Blocked: this would put your 24h ${e.symbol} total at ${already + e.amount} raw, over the ` +
            `rolling daily limit of ${dailyCap} raw (already moved ${already}). ` +
            `The daily limit is ${DAILY_TOKEN_CAP_MULTIPLE}x the per-transaction cap - raise that with ` +
            `"/limits token ${e.symbol} <amount>", or wait for the window to roll.`,
        );
      }
    }
  }
}

/** The ERC-20 amount this step commits against the rolling 24h token window. */
function tokenSpent(plan: SignablePlan): { symbol: string; amount: bigint } | undefined {
  const e = plan.policy.erc20;
  if (!e || e.kind === "approval") return undefined;
  if (e.symbol === "BTC" || plan.to.toLowerCase() === BTC_PRECOMPILE.toLowerCase()) return undefined;
  return { symbol: e.symbol, amount: e.amount };
}

/** True when the account is an EIP-7702 smart account with a live session key. */
function usableSession(user: UserRecord): SessionKey | undefined {
  if (!user.delegation || !user.session) return undefined;
  if (user.session.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
  return user.session;
}

export async function signAndSubmit(user: UserRecord, plan: SignablePlan): Promise<Hex> {
  // App-layer policy re-check (defense in depth) runs regardless of path. For a
  // delegated account the delegate contract ALSO enforces caps/allowlist/expiry
  // on-chain, so a bypass of this layer still cannot exceed scope.
  assertPolicy(user, plan);

  // Reserve the BTC moved against the daily cap BEFORE submitting. assertPolicy
  // and this reservation run synchronously (no await between them), so two rapid
  // actions can't both pass the check against a stale total — closing the TOCTOU.
  // Uses btcWeiMoved (not msg.value) so precompile BTC spends are also ledgered.
  // BOTH reservations are taken INSIDE the guarded region and released in a
  // `finally`. They used to sit above the `try`, and `store.addSpend` flushes to
  // disk — so if the TOKEN reservation's write threw, the BTC reservation was
  // already committed, the throw originated outside the `try`, the `catch` never
  // ran, and that reservation was permanent. Leaked reservations only age out
  // after 24h, so repeats ratchet the user's own daily budget toward zero and
  // lock them out of their funds over spend that never happened.
  let reservation: string | undefined;
  let tokenReservation: string | undefined;
  let committed = false;
  try {
    const at = new Date().toISOString();
    reservation = store.addSpend(user.telegramId, btcWeiSpent(plan), at);
    // Same reserve-before-submit discipline for the token window.
    const tok = tokenSpent(plan);
    if (tok) tokenReservation = store.addSpend(user.telegramId, tok.amount, at, tok.symbol);

    const session = usableSession(user);
    const hash = await submitWithin(user, plan, session);
    committed = true;
    return hash;
  } finally {
    // Release unless the submission actually went out. A `finally` (not a
    // `catch`) so an early return or a throw from anywhere in the block —
    // including the reservation writes themselves — cannot leak.
    if (!committed) {
      if (reservation) store.releaseSpend(reservation);
      if (tokenReservation) store.releaseSpend(tokenReservation);
    }
  }
}

/** The submission itself, split out so the reservation guard above stays flat. */
async function submitWithin(user: UserRecord, plan: SignablePlan, session: SessionKey | undefined): Promise<Hex> {
  {
    if (!session) return await submitDirect(user, plan);

    // Session path: the delegate enforces an ON-CHAIN allowlist frozen at
    // /upgrade time, so a contract wired later (FeeRouter) or a target older
    // builds missed (the BTC precompile) reverts with TargetNotAllowed /
    // SpenderNotAllowed — invisible to our eth_call simulation, which doesn't
    // go through the delegate. Check first; self-heal via the root key; if the
    // target still isn't allowed, fall back to root-signed direct submission
    // (off-chain policy above has already vetted the op).
    if (!(await sessionCanExecute(user.address, session.address as Address, plan))) {
      try {
        const { ensureSessionTargets } = await import("./delegation.js");
        await ensureSessionTargets(user);
      } catch { /* healing is best-effort */ }
      if (!(await sessionCanExecute(user.address, session.address as Address, plan))) {
        // REFUSE, do not downgrade.
        //
        // This used to fall through to submitDirect — re-signing with the ROOT
        // key any operation the delegate had just refused. That makes the
        // delegate's on-chain caps advisory: anything outside them is not
        // blocked, merely routed around, so the guarantee the smart-account path
        // advertises would be void the moment it shipped. It was unreachable
        // only because /upgrade is disabled, which is not a property to rely on.
        //
        // Self-healing above still covers the legitimate case (a contract wired
        // into the registry after the account was upgraded). If the target is
        // STILL not allowed after that, the delegate is deliberately saying no.
        throw new PolicyViolationError(
          `This account's on-chain session policy doesn't permit calling ${plan.to}, and I won't ` +
            `sign around that with your root key - the whole point of the session key is that its ` +
            `limits actually bind. Use /revoke to drop the session key if you want to sign directly again.`,
        );
      }
    }
    return await submitViaSession(user, session, plan);
  }
}

const SEL_APPROVE_HEX = "0x095ea7b3";

/** Would the session delegate accept this op? (target + approve-spender allowlist) */
async function sessionCanExecute(account: Address, sessionKey: Address, plan: SignablePlan): Promise<boolean> {
  try {
    const allowed = (await publicClient().readContract({
      address: account, abi: sessionKeyDelegateAbi, functionName: "isAllowed", args: [sessionKey, plan.to],
    })) as boolean;
    if (!allowed) return false;
    // approve(spender, …): the delegate also requires the SPENDER to be an
    // allowlisted target — decode it and check.
    if (plan.data && plan.data.slice(0, 10).toLowerCase() === SEL_APPROVE_HEX) {
      const spender = ("0x" + plan.data.slice(34, 74)) as Address;
      return (await publicClient().readContract({
        address: account, abi: sessionKeyDelegateAbi, functionName: "isAllowed", args: [sessionKey, spender],
      })) as boolean;
    }
    return true;
  } catch {
    // Can't read the delegate (not actually delegated?) — let the session path
    // proceed and fail loudly rather than silently downgrade.
    return true;
  }
}

// Mezo is a Cosmos-EVM chain whose `eth_estimateGas` frequently returns an opaque
// "rpc error: code = Unknown" even for transactions that pass `eth_call` and would
// execute fine. viem runs estimateGas inside sendTransaction, so the send dies
// there. We estimate with a buffer and, on failure, fall back to a generous fixed
// limit — safe because every caller has ALREADY eth_call-simulated the step before
// signing, so a reached tx is known-valid. Gas is near-free on Mezo, so an
// over-estimate costs almost nothing (you pay for gas USED, not the limit).
const FALLBACK_GAS = 3_000_000n;
async function resolveGas(from: Address, to: Address, data?: Hex, value?: bigint): Promise<bigint> {
  try {
    const est = await publicClient().estimateGas({ account: from, to, data, value });
    return (est * 12n) / 10n; // +20% headroom
  } catch {
    return FALLBACK_GAS;
  }
}

/** Legacy path: the root EOA signs and submits the transaction directly. */
async function submitDirect(user: UserRecord, plan: SignablePlan): Promise<Hex> {
  const chain = chainFor(env.network);
  return keystore().use(user.sealedKey, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== user.address.toLowerCase()) {
      throw new PolicyViolationError("Sealed key does not match the account address.");
    }
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });
    const gas = await resolveGas(account.address, plan.to, plan.data, plan.value);
    const request: TransactionRequest = {
      to: plan.to,
      data: plan.data,
      value: plan.value,
      gas,
    };
    // Explicit gas so viem skips its flaky estimateGas; native BTC pays gas on Mezo.
    return wallet.sendTransaction(request as never);
  });
}

/**
 * EIP-7702 path: the SESSION key sends `execute(to, value, data)` to the
 * delegated root account. The op runs in the account's context and is bounded
 * on-chain by the delegate. The root key is never touched here.
 */
async function submitViaSession(
  user: UserRecord,
  session: SessionKey,
  plan: SignablePlan,
): Promise<Hex> {
  const chain = chainFor(env.network);
  const data = encodeFunctionData({
    abi: sessionKeyDelegateAbi,
    functionName: "execute",
    args: [plan.to, plan.value ?? 0n, plan.data ?? "0x"],
  });
  return keystore().use(session.sealedKey, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== session.address.toLowerCase()) {
      throw new PolicyViolationError("Sealed session key does not match its address.");
    }
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });
    // Target the account (root EOA); the delegate forwards to plan.to.
    const gas = await resolveGas(account.address, user.address, data, undefined);
    const request: TransactionRequest = { to: user.address, data, gas };
    return wallet.sendTransaction(request as never);
  });
}
