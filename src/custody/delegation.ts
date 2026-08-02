import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { chainFor } from "../chain/networks.js";
import { publicClient } from "../chain/client.js";
import { getDelegation } from "../chain/eip7702.js";
import { registry } from "../registry/registry.js";
import { sessionKeyDelegateAbi } from "../abis/delegate.js";
import { store, type UserRecord } from "../db/store.js";
import { limitsOf } from "./policy.js";
import { LocalKeyStore } from "./localKeystore.js";
import { log, errMsg } from "../core/log.js";

/**
 * Delegation service — "Option A" (semi-custodial) account upgrade.
 *
 * Turns a plain contained-custodial EOA into an EIP-7702 smart account:
 *   1. generate a scoped SESSION key (sealed like the root),
 *   2. have the ROOT self-sign a type-0x04 authorization pointing the EOA at the
 *      registry's SessionKeyDelegate, and in the SAME transaction call
 *      `registerSession(...)` to install the session on-chain,
 *   3. best-effort fund the session key with a little native BTC for gas.
 *
 * After this, day-to-day ops are signed by the session key (see signer.ts) and
 * are bounded on-chain by the delegate, independent of any off-chain check.
 */

const SESSION_TTL_DAYS = 30;
/** Small native top-up so the freshly-minted session key can pay for gas. */
const SESSION_GAS_TOPUP_WEI = parseEther("0.002");

let _keystore: LocalKeyStore | undefined;
function keystore(): LocalKeyStore {
  return (_keystore ??= new LocalKeyStore());
}

export class DelegationError extends Error {}

/**
 * Least-privilege on-chain scope for a session key.
 *
 * Each target carries ONLY the selectors the agent actually needs, plus caps on
 * any ERC-20 amount decoded from calldata — so the on-chain policy bounds token
 * value, not just native value (audit finding F3). Token caps are derived from
 * the user's own native limits scaled by a conservative BTC price bound; they
 * are intentionally coarse because they are a BACKSTOP: the off-chain signer
 * enforces the precise per-action amount, and this stops a compromised key from
 * exceeding it by more than the cap.
 */
type TargetPolicy = {
  target: Address;
  selectors: Hex[];
  tokenPerTxCap: bigint;
  tokenDailyCap: bigint;
  /** Opt-in for targets exposing selectors the delegate cannot decode. Keep
   *  FALSE: the delegate denies undecodable selectors by default because the
   *  target allowlist gates who is CALLED, never who gets PAID (audit). */
  allowUndecodedSelectors: boolean;
};

// Selectors the agent needs. Anything not listed reverts on-chain.
const SEL_APPROVE = toFunctionSelector("approve(address,uint256)");
const SEL_TRANSFER = toFunctionSelector("transfer(address,uint256)");
const SEL_SWAP_TOKENS = toFunctionSelector(
  "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)",
);
const SEL_SWAP_ETH = toFunctionSelector(
  "swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256)",
);
const SEL_SWAP_FOR_ETH = toFunctionSelector(
  "swapExactTokensForETH(uint256,uint256,(address,address,bool,address)[],address,uint256)",
);
const SEL_SWAP_WITH_FEE = toFunctionSelector(
  "swapWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)",
);

/**
 * Coarse USD-ish ceiling used to convert a native BTC cap into a token cap.
 * Deliberately generous (a backstop, not the primary limit) but finite, so an
 * ERC-20 drain is bounded even if every off-chain check is bypassed.
 */
const BTC_UPPER_BOUND_USD = 250_000n;

/**
 * Convert the native BTC cap into a per-token cap.
 *
 * AUDIT FIX: the previous formula multiplied the USD ceiling by the token's
 * unit unconditionally, i.e. it asserted "1 token == $1". That is right for the
 * stables but catastrophically wrong for BTC-denominated ERC-20s (mcbBTC,
 * mFBTC, mswBTC, mSolvBTC, mxSolvBTC): a 0.05 BTC (~$12.5k) limit became
 * 12,500 mcbBTC (~$1.25B) — a ~100,000x hole in the backstop. BTC-denominated
 * tokens are now capped by the NATIVE limit directly (1 token ≈ 1 BTC), which
 * is the correct unit for them.
 */
function tokenCapsFor(
  limits: ReturnType<typeof limitsOf>,
  decimals: number,
  symbol: string,
): { perTx: bigint; daily: bigint } {
  const unit = 10n ** BigInt(decimals);
  const btcDenominated = /btc/i.test(symbol);
  if (btcDenominated) {
    // 1 unit ≈ 1 BTC → scale the native wei cap into this token's decimals.
    return {
      perTx: (BigInt(limits.perTxNativeWei) * unit) / 10n ** 18n,
      daily: (BigInt(limits.dailyNativeWei) * unit) / 10n ** 18n,
    };
  }
  // Dollar-denominated token: the USD ceiling maps 1:1 onto token units.
  return {
    perTx: (BigInt(limits.perTxNativeWei) * BTC_UPPER_BOUND_USD * unit) / 10n ** 18n,
    daily: (BigInt(limits.dailyNativeWei) * BTC_UPPER_BOUND_USD * unit) / 10n ** 18n,
  };
}

function sessionPolicies(limits: ReturnType<typeof limitsOf>): TargetPolicy[] {
  const policies: TargetPolicy[] = [];
  if (registry.hasContract("Router")) {
    policies.push({
      target: registry.contract("Router"),
      selectors: [SEL_SWAP_TOKENS, SEL_SWAP_ETH, SEL_SWAP_FOR_ETH],
      tokenPerTxCap: 0n, // the router is not an ERC-20; no decoded transfers
      tokenDailyCap: 0n,
      allowUndecodedSelectors: false,
    });
  }
  // FeeRouter (atomic swap+fee wrapper). Must be a TARGET both to be called and
  // to be a legal `approve` spender (the delegate rejects approvals to
  // non-target spenders — the exact revert users hit before this was added).
  if (registry.hasContract("FeeRouter")) {
    policies.push({
      target: registry.contract("FeeRouter"),
      selectors: [SEL_SWAP_WITH_FEE],
      tokenPerTxCap: 0n,
      tokenDailyCap: 0n,
      allowUndecodedSelectors: false,
    });
  }
  for (const t of registry.allTokens()) {
    // Native BTC spends through its ERC-20 precompile — the precompile IS the
    // approval/transfer target for BTC, so it needs a policy like any token.
    // (It was previously skipped, which broke every BTC-input approval on
    // upgraded accounts.)
    const target = registry.routingAddress(t);
    const caps = t.native
      ? { perTx: BigInt(limits.perTxNativeWei), daily: BigInt(limits.dailyNativeWei) }
      : tokenCapsFor(limits, t.decimals, t.symbol);
    policies.push({
      // approve is needed for swaps; transfer for fee payment / moves.
      target,
      selectors: [SEL_APPROVE, SEL_TRANSFER],
      tokenPerTxCap: caps.perTx,
      tokenDailyCap: caps.daily,
      allowUndecodedSelectors: false,
    });
  }
  return policies;
}

/**
 * Self-heal an EXISTING session's on-chain allowlist. Sessions freeze their
 * target policies at /upgrade time, so contracts added later (e.g. FeeRouter)
 * — or targets missed by older builds (the BTC precompile) — are rejected by
 * the delegate with TargetNotAllowed/SpenderNotAllowed. The ROOT key can fix
 * that: setTargetPolicy is onlySelf, and a root-signed tx to the account itself
 * satisfies msg.sender == address(this). Idempotent: only missing targets are
 * installed. Returns how many policies were added.
 */
export async function ensureSessionTargets(user: UserRecord): Promise<number> {
  if (!user.session) return 0;
  const session = user.session.address as Address;
  const limits = limitsOf(user.limits);
  const wanted = sessionPolicies(limits);

  const missing: TargetPolicy[] = [];
  for (const p of wanted) {
    try {
      const ok = (await publicClient().readContract({
        address: user.address,
        abi: sessionKeyDelegateAbi,
        functionName: "isAllowed",
        args: [session, p.target],
      })) as boolean;
      if (!ok) missing.push(p);
    } catch {
      // Unreadable (not delegated / RPC) — nothing to heal here.
      return 0;
    }
  }
  if (missing.length === 0) return 0;

  const chain = chainFor(env.network);
  await keystore().use(user.sealedKey, async (rootKey: Hex) => {
    const rootAccount = privateKeyToAccount(rootKey);
    const wallet = createWalletClient({ account: rootAccount, chain, transport: http(chain.rpcUrls.default.http[0]) });
    for (const p of missing) {
      const data = encodeFunctionData({
        abi: sessionKeyDelegateAbi,
        functionName: "setTargetPolicy",
        args: [session, { target: p.target, selectors: p.selectors, tokenPerTxCap: p.tokenPerTxCap, tokenDailyCap: p.tokenDailyCap, allowUndecodedSelectors: p.allowUndecodedSelectors }],
      });
      const hash = await wallet.sendTransaction({ to: user.address, data, gas: 500_000n } as never);
      await publicClient().waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 6 });
      log.info("delegation.target-synced", { target: p.target });
    }
  });
  return missing.length;
}

export async function isSmartAccount(user: UserRecord): Promise<boolean> {
  if (!user.delegation || !user.session) return false;
  const status = await getDelegation(user.address, user.delegation.target);
  return status.delegated && status.matchesExpected;
}

/**
 * Upgrade the account to an EIP-7702 smart account. Idempotent: if the on-chain
 * delegation already points at our delegate, it just returns the record.
 */
export async function enableSmartAccount(user: UserRecord): Promise<UserRecord> {
  if (!registry.hasContract("Delegate7702")) {
    throw new DelegationError(
      "No SessionKeyDelegate is configured for this network yet. Deploy it and " +
        "add its address to the registry before upgrading accounts.",
    );
  }
  const delegate = registry.contract("Delegate7702");
  const chain = chainFor(env.network);

  // Already delegated to our contract? Nothing to do.
  const existing = await getDelegation(user.address, delegate);
  if (existing.delegated && existing.matchesExpected && user.session && user.delegation) {
    return user;
  }

  // 1. Generate + seal the scoped session key.
  const sessionPk = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPk);
  const sessionSealed = await keystore().seal(sessionPk);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

  const limits = limitsOf(user.limits);
  const registerData = encodeFunctionData({
    abi: sessionKeyDelegateAbi,
    functionName: "registerSession",
    args: [
      sessionAccount.address,
      expiresAt,
      BigInt(limits.perTxNativeWei),
      BigInt(limits.dailyNativeWei),
      sessionPolicies(limits),
    ],
  });

  // 2. Root self-signs the 7702 authorization and installs the delegation +
  //    session in a single set-code transaction. `executor: "self"` tells viem
  //    the signer of the authorization is also the tx sender (nonce is bumped
  //    accordingly).
  const txHash = await keystore().use(user.sealedKey, async (rootKey: Hex) => {
    const rootAccount = privateKeyToAccount(rootKey);
    if (rootAccount.address.toLowerCase() !== user.address.toLowerCase()) {
      throw new DelegationError("Sealed root key does not match the account address.");
    }
    const wallet = createWalletClient({
      account: rootAccount,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });

    const authorization = await wallet.signAuthorization({
      account: rootAccount,
      contractAddress: delegate,
      executor: "self",
    });

    return wallet.sendTransaction({
      authorizationList: [authorization],
      to: user.address,
      data: registerData,
    } as never);
  });

  log.step("delegation:enable", "set-code-submitted", {
    user: user.telegramId,
    address: user.address,
    hash: txHash,
  });

  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new DelegationError(`Delegation transaction reverted (${txHash}).`);
  }

  // 3. Persist the upgrade.
  user.accountType = "eip7702-delegated";
  user.session = { address: sessionAccount.address, sealedKey: sessionSealed, expiresAt };
  user.delegation = { target: delegate, installedAt: new Date().toISOString(), txHash };
  store.saveUser(user);

  // 4. Best-effort gas top-up for the session key (owner moving own funds).
  await fundSessionForGas(user).catch((err) =>
    log.warn("delegation:enable.gas-topup-failed", { error: errMsg(err) }),
  );

  return user;
}

/** Send a small native top-up from the root to the session key for gas. */
async function fundSessionForGas(user: UserRecord): Promise<void> {
  if (!user.session) return;
  const chain = chainFor(env.network);
  const balance = await publicClient().getBalance({ address: user.address });
  // Only fund if the root can comfortably cover the top-up plus its own gas.
  if (balance < SESSION_GAS_TOPUP_WEI * 2n) return;

  await keystore().use(user.sealedKey, async (rootKey: Hex) => {
    const rootAccount = privateKeyToAccount(rootKey);
    const wallet = createWalletClient({
      account: rootAccount,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });
    const hash = await wallet.sendTransaction({
      to: user.session!.address,
      value: SESSION_GAS_TOPUP_WEI,
    } as never);
    await publicClient().waitForTransactionReceipt({ hash });
  });
}
