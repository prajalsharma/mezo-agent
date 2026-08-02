import type { Address } from "viem";
import { env, feesEnabled } from "../config/env.js";
import { store } from "../db/store.js";
import { getUser } from "../wallet/walletService.js";

/**
 * Single source of truth for "does this trader's action carry a referral?".
 * Used by the interactive swap handler, the zap path, and the DCA keeper so
 * every swap a referred user makes — manual or scheduled — gets the same
 * lifetime discount and pays the same referrer share (audit: the keeper
 * previously bypassed referral entirely, over-charging referred users and
 * paying referrers nothing on recurring flow).
 */
export type ReferralCtx = {
  recipient: Address;
  sharePct: number;
  /** For the earnings ledger — captured at BUILD time so a later store change
   *  can never leave an on-chain payout unledgered. */
  referrerTelegramId: number;
};

export function referralFor(telegramId: number, traderAddress: string): ReferralCtx | undefined {
  // No fee → no split; share of 0 must NOT grant the discount (pure-loss config).
  if (!feesEnabled || env.fees.referralSharePct <= 0) return undefined;
  const referrerId = store.referrerOf(telegramId);
  if (referrerId === undefined) return undefined;
  const rec = getUser(referrerId);
  if (!rec) return undefined;
  // Self-referral guard beyond the telegram-id check: a second Telegram account
  // that imported the SAME wallet would otherwise pay itself 30% of its own fee.
  if (rec.address.toLowerCase() === traderAddress.toLowerCase()) return undefined;
  return { recipient: rec.address as Address, sharePct: env.fees.referralSharePct, referrerTelegramId: referrerId };
}
