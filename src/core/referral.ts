import type { Address } from "viem";
import { env, feesEnabled } from "../config/env.js";
import { store } from "../db/store.js";
import { attest } from "../custody/attest.js";
import { getUser } from "../wallet/walletService.js";
import { publicClient } from "../chain/client.js";
import { feeRouterCaps } from "../chain/feeRouterCaps.js";
import { feeRouterAbi } from "../abis/router.js";
import { log, errMsg } from "./log.js";

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

/**
 * On-chain binding cache. The FeeRouter pays a referrer ONLY when
 * referrerOf[trader] == referrer, so an off-chain link alone is not enough:
 * quoting a discount or crediting the ledger without the binding would promise
 * a payout the chain never makes (audit - the ledger was documented as "not an
 * unsettled liability", which held only while the binding existed).
 */
/** Sentinel: this router predates the binding registry, so skip the check. */
const SKIP_BINDING = "skip";
const bindingCache = new Map<string, { referrer: string; at: number }>();
const BINDING_TTL_MS = 5 * 60 * 1000;

/**
 * The referrer's share, read from the contract. The FeeRouter pays
 * `maxReferralShareBps` of the fee whenever the trader is bound - it no longer
 * honours a share passed in calldata - so deriving the quoted/ledgered amount
 * from AGENT_REFERRAL_SHARE_PCT would misstate what the chain actually paid the
 * moment the two disagree. One source of truth, same reasoning as the binding.
 */
let sharePctCache: { pct: number; at: number } | undefined;

async function onChainSharePct(): Promise<number | undefined> {
  if (!env.contracts.feeRouter) return undefined;
  if (sharePctCache && Date.now() - sharePctCache.at < BINDING_TTL_MS) return sharePctCache.pct;
  try {
    const bps = (await publicClient().readContract({
      address: env.contracts.feeRouter as Address,
      abi: feeRouterAbi,
      functionName: "maxReferralShareBps",
    })) as number;
    const pct = Number(bps) / 100;
    sharePctCache = { pct, at: Date.now() };
    return pct;
  } catch (e) {
    log.warn("referral.share-read-failed", { error: errMsg(e) });
    return undefined;
  }
}

async function boundReferrer(trader: string): Promise<string | undefined> {
  if (!env.contracts.feeRouter) return undefined;
  // An older router has no binding registry; it honours the referrer passed in
  // calldata, so requiring a binding there would silently kill every referral.
  if (!(await feeRouterCaps()).referrerOf) return trader ? SKIP_BINDING : SKIP_BINDING;
  const key = trader.toLowerCase();
  const hit = bindingCache.get(key);
  if (hit && Date.now() - hit.at < BINDING_TTL_MS) return hit.referrer;
  try {
    const onChain = (await publicClient().readContract({
      address: env.contracts.feeRouter as Address,
      abi: feeRouterAbi,
      functionName: "referrerOf",
      args: [trader as Address],
    })) as string;
    bindingCache.set(key, { referrer: onChain.toLowerCase(), at: Date.now() });
    return onChain.toLowerCase();
  } catch (e) {
    // Fail CLOSED: an RPC blip must not conjure a discount the chain won't honour.
    log.warn("referral.binding-read-failed", { error: errMsg(e) });
    return undefined;
  }
}

export async function referralFor(telegramId: number, traderAddress: string): Promise<ReferralCtx | undefined> {
  // No fee → no split; share of 0 must NOT grant the discount (pure-loss config).
  if (!feesEnabled || env.fees.referralSharePct <= 0) return undefined;
  const referrerId = store.referrerOf(telegramId);
  if (referrerId === undefined) return undefined;
  const rec = getUser(referrerId);
  if (!rec) return undefined;
  // Self-referral guard beyond the telegram-id check: a second Telegram account
  // that imported the SAME wallet would otherwise pay itself 30% of its own fee.
  if (rec.address.toLowerCase() === traderAddress.toLowerCase()) return undefined;
  // The chain is the authority on whether this pair is bound. Without it the
  // FeeRouter charges full price and pays the referrer nothing, so quoting a
  // discount here would misprice the trade and ledger a phantom earning.
  const bound = await boundReferrer(traderAddress);
  if (bound !== SKIP_BINDING && (!bound || bound !== rec.address.toLowerCase())) return undefined;
  // Prefer the contract's rate; fall back to env only on the legacy
  // (no FeeRouter) split path, where the bot builds the transfer itself.
  const sharePct = (await onChainSharePct()) ?? env.fees.referralSharePct;
  if (sharePct <= 0) return undefined;
  // The referrer's payout wallet is another user's own account address, read
  // from the local store and confirmed against the on-chain binding above — not
  // something a model or a message can influence. It cannot be in the compiled-in
  // registry, so record it explicitly for the signer's independent target check.
  attest(rec.address as Address, `referrer payout wallet for telegram:${referrerId}`);
  return { recipient: rec.address as Address, sharePct, referrerTelegramId: referrerId };
}
