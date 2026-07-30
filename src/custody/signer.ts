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
import { limitsOf, fmtBtc, tokenCapOf, BTC_PRECOMPILE } from "./policy.js";

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
    /** ERC-20 amount this step moves, for per-token cap enforcement (optional). */
    erc20?: { symbol: string; amount: bigint };
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
    if (spent + btc > daily) {
      throw new PolicyViolationError(
        `Blocked: this would put 24h spend at ${fmtBtc(spent + btc)}, over the daily ` +
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
  }
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
  const reservation = store.addSpend(user.telegramId, btcWeiMoved(plan), new Date().toISOString());

  const session = usableSession(user);
  try {
    return session
      ? await submitViaSession(user, session, plan)
      : await submitDirect(user, plan);
  } catch (err) {
    // Submission failed — release the reservation so it doesn't count against the cap.
    store.releaseSpend(reservation);
    throw err;
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
