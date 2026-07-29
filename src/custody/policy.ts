import { formatEther, parseEther, parseUnits, type Address } from "viem";

/**
 * Spending policy — the bounty requires "spending limits and confirmation
 * thresholds so a compromised session cannot drain an account."
 *
 * Hard caps on BTC value moved per transaction and per rolling 24h window, plus
 * per-token raw-amount caps, all enforced in the signer (defense in depth: the
 * signer refuses to sign an over-cap tx even if every other layer is bypassed),
 * plus a watch-only mode.
 *
 * CRITICAL on Mezo: native BTC is spent through its ERC-20 precompile
 * (WRAPPED_NATIVE_ADDRESS), so a BTC-moving transaction carries `value: 0n` and
 * the BTC amount lives in calldata. The signer therefore must treat approvals /
 * transfers of the BTC precompile as native spend — measuring only `msg.value`
 * would leave every lock/swap/zap/vault/stake uncapped. (Audit R2 C1.)
 *
 * Amounts are stored as decimal strings (wei) because JSON cannot hold bigint.
 */
export type SpendingLimits = {
  /** Max BTC (wei) movable in a single transaction (native OR via precompile). */
  perTxNativeWei: string;
  /** Max BTC (wei) movable within any rolling 24h window. */
  dailyNativeWei: string;
  /** BTC value (wei) above which the UI requires a step-up confirmation. */
  confirmationThresholdNativeWei: string;
  /**
   * Per-transaction caps on ERC-20 amounts, keyed by token symbol, as raw
   * (smallest-unit) decimal strings. Enforced in the signer. Ships with
   * conservative defaults so the cap is never silently absent (Audit R2 H8);
   * settable via `/limits token <SYMBOL> <amount>`.
   */
  perTxTokenCaps: Record<string, string>;
};

/**
 * Conservative per-token defaults so an ERC-20 outbound plan is never uncapped.
 * Raw units (decimals baked in). A token with no entry falls back to
 * UNKNOWN_TOKEN_CAP_RAW rather than "unlimited" — fail-closed, not fail-open.
 */
const TOKEN_DECIMALS: Record<string, number> = { MUSD: 18, mUSDC: 6, mUSDT: 6, MEZO: 18 };
const TOKEN_DEFAULT_HUMAN: Record<string, string> = {
  MUSD: "10000", mUSDC: "10000", mUSDT: "10000", MEZO: "100000",
};
/** Fallback cap for any ERC-20 the defaults don't name (assumes 18-dec worst case). */
export const UNKNOWN_TOKEN_CAP_RAW = parseUnits("1000", 18).toString();

function defaultTokenCaps(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sym, human] of Object.entries(TOKEN_DEFAULT_HUMAN)) {
    out[sym] = parseUnits(human, TOKEN_DECIMALS[sym] ?? 18).toString();
  }
  return out;
}

/**
 * Per-tx raw-amount cap for a token symbol. Never returns undefined: an unknown
 * token gets the conservative fallback, so the signer's ERC-20 branch is always
 * live (Audit R2 H8 — previously this returned undefined for every call because
 * no code path populated perTxTokenCaps).
 */
export function tokenCapOf(limits: SpendingLimits | undefined, symbol: string): bigint {
  const caps = limitsOf(limits).perTxTokenCaps;
  const raw = caps[symbol];
  return BigInt(raw ?? UNKNOWN_TOKEN_CAP_RAW);
}

export const DEFAULT_LIMITS: SpendingLimits = {
  perTxNativeWei: parseEther("0.05").toString(),
  dailyNativeWei: parseEther("0.2").toString(),
  confirmationThresholdNativeWei: parseEther("0.02").toString(),
  perTxTokenCaps: defaultTokenCaps(),
};

export function limitsOf(limits: SpendingLimits | undefined): SpendingLimits {
  // Merge so a legacy record persisted before perTxTokenCaps existed still gets
  // the defaults rather than an empty (fail-open) map.
  if (!limits) return DEFAULT_LIMITS;
  return {
    ...limits,
    perTxTokenCaps: { ...defaultTokenCaps(), ...(limits.perTxTokenCaps ?? {}) },
  };
}

export function fmtBtc(wei: string | bigint): string {
  return `${formatEther(typeof wei === "bigint" ? wei : BigInt(wei))} BTC`;
}

/** The BTC ERC-20 precompile — an approval/transfer here is a native BTC spend. */
export const BTC_PRECOMPILE = "0x7b7C000000000000000000000000000000000000" as Address;
