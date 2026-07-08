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
   * (extra verification). Enforcement of the step-up lives in the handler; the
   * threshold is defined here so policy is centralized.
   */
  confirmationThresholdNativeWei: string;
};

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
