import { formatEther, parseEther } from "viem";

/**
 * Spending policy — the bounty requires "spending limits and confirmation
 * thresholds so a compromised session cannot drain an account."
 *
 * Phase 1 scaffold: hard caps on NATIVE BTC value moved per transaction and per
 * rolling 24h window, enforced in the signer (defense in depth: the signer
 * refuses to sign an over-cap tx even if every other layer is bypassed), plus a
 * watch-only mode. Per-token (ERC-20) USD caps arrive with the price-feed
 * integration in a later phase; that limitation is documented, not hidden.
 *
 * Amounts are stored as decimal strings (wei) because JSON cannot hold bigint.
 */
export type SpendingLimits = {
  /** Max native BTC (wei) movable in a single transaction. */
  perTxNativeWei: string;
  /** Max native BTC (wei) movable within any rolling 24h window. */
  dailyNativeWei: string;
  /**
   * Native value (wei) above which a step-up confirmation is required in the UI
   * (extra verification), enforced in the swap handler.
   */
  confirmationThresholdNativeWei: string;
  /**
   * Optional per-transaction caps on ERC-20 amounts, keyed by token symbol, as
   * raw (smallest-unit) decimal strings. Enforced in the signer. Undefined =>
   * no per-token cap. A true USD-denominated cap arrives with the price feed;
   * this raw-amount cap is the interim, documented mechanism.
   */
  perTxTokenCaps?: Record<string, string>;
};

/** Resolve the per-tx raw-amount cap for a token symbol, if any. */
export function tokenCapOf(limits: SpendingLimits | undefined, symbol: string): bigint | undefined {
  const caps = limitsOf(limits).perTxTokenCaps;
  const raw = caps?.[symbol];
  return raw === undefined ? undefined : BigInt(raw);
}

/** Conservative testnet defaults. Tunable per user via /limits in later phases. */
export const DEFAULT_LIMITS: SpendingLimits = {
  perTxNativeWei: parseEther("0.05").toString(),
  dailyNativeWei: parseEther("0.2").toString(),
  confirmationThresholdNativeWei: parseEther("0.02").toString(),
};

export function limitsOf(limits: SpendingLimits | undefined): SpendingLimits {
  return limits ?? DEFAULT_LIMITS;
}

export function fmtBtc(wei: string | bigint): string {
  return `${formatEther(typeof wei === "bigint" ? wei : BigInt(wei))} BTC`;
}
