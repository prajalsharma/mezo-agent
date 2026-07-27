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
import { store, type UserRecord, type SessionKey } from "../db/store.js";
import { sessionKeyDelegateAbi } from "../abis/delegate.js";
import { LocalKeyStore } from "./localKeystore.js";
import { limitsOf, fmtBtc, tokenCapOf } from "./policy.js";

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

  // Spending caps on NATIVE BTC value moved. A compromised session cannot exceed
  // these even if it bypasses the app-level confirmation.
  const value = plan.value ?? 0n;
  if (value > 0n) {
    const limits = limitsOf(user.limits);
    const perTx = BigInt(limits.perTxNativeWei);
    if (value > perTx) {
      throw new PolicyViolationError(
        `Blocked: ${fmtBtc(value)} exceeds the per-transaction limit of ${fmtBtc(perTx)}. ` +
          `Raise it with /limits.`,
      );
    }
    const daily = BigInt(limits.dailyNativeWei);
    const spent = store.spentLast24hWei(user.telegramId);
    if (spent + value > daily) {
      throw new PolicyViolationError(
        `Blocked: this would put 24h spend at ${fmtBtc(spent + value)}, over the daily ` +
          `limit of ${fmtBtc(daily)} (already spent ${fmtBtc(spent)}). Raise it with /limits.`,
      );
    }
  }

  // Optional per-token (ERC-20) raw-amount cap. Off by default; a USD-denominated
  // cap arrives with the price feed. When set, it bounds a single token transfer.
  if (plan.policy.erc20) {
    const cap = tokenCapOf(user.limits, plan.policy.erc20.symbol);
    if (cap !== undefined && plan.policy.erc20.amount > cap) {
      throw new PolicyViolationError(
        `Blocked: this moves more ${plan.policy.erc20.symbol} than your per-transaction cap for that token. Raise it with /limits.`,
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

  // Reserve the native value against the daily cap BEFORE submitting. assertPolicy
  // and this reservation run synchronously (no await between them), so two rapid
  // actions can't both pass the check against a stale total — closing the TOCTOU.
  const value = plan.value ?? 0n;
  const reservation = store.addSpend(user.telegramId, value, new Date().toISOString());

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
    const request: TransactionRequest = {
      to: plan.to,
      data: plan.data,
      value: plan.value,
    };
    // viem estimates gas / fees; native BTC is the gas asset on Mezo.
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
    const request: TransactionRequest = { to: user.address, data };
    return wallet.sendTransaction(request as never);
  });
}
