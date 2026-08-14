import { store } from "../db/store.js";
import { getUser } from "../wallet/walletService.js";
import { readTrove } from "../surfaces/borrow.js";
import { buildClaim } from "../surfaces/earn.js";
import { ownedVeNfts } from "../core/veEnumeration.js";
import { btcPriceUsd } from "../core/prices.js";
import { musdParams } from "../core/musdParams.js";
import { log, errMsg } from "../core/log.js";

/**
 * Proactive alerts — the bot messages FIRST, but only for alert types a user
 * explicitly enabled under /alerts (all OFF by default; anti-phishing stance:
 * outside these, the bot never initiates). Every alert is fully deterministic —
 * keeper reads + static templates, no LLM anywhere — and ends with the exact
 * command to act on it.
 *
 * Anti-spam rules (state persisted per user):
 *   trove   — alert when ICR < 150%; re-alert only if ICR dropped ≥10 points
 *             below the last alerted band, or after a 24h cooldown.
 *   rewards — at most once per 24h, only when something is actually claimable.
 *   epoch   — once per epoch, in the final 24h before the weekly flip, only for
 *             users who actually hold veNFTs (no noise for everyone else).
 */

const SWEEP_MS = 30 * 60 * 1000; // 30 min between sweeps
const TROVE_WARN_ICR = 150; // %
const TROVE_REALERT_DROP = 10; // points below last alerted ICR
/**
 * Floor on how often a Trove alert may repeat, independent of the band and of
 * whether the ratio recovered in between. Without it, a ratio oscillating
 * across the warning threshold alerts on every other 30-minute sweep.
 */
const MIN_REALERT_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** ve(3,3) epochs flip weekly at Thursday 00:00 UTC (unix epoch was a Thursday). */
const WEEK_MS = 7 * DAY_MS;

export type Notify = (telegramId: number, text: string) => Promise<void>;

/** Start of the current weekly epoch (ms). Exported for tests. */
export function epochStartMs(now = Date.now()): number {
  return Math.floor(now / WEEK_MS) * WEEK_MS;
}

/** ms remaining until the next weekly epoch flip. Exported for tests. */
export function msToEpochFlip(now = Date.now()): number {
  return epochStartMs(now) + WEEK_MS - now;
}

let timer: ReturnType<typeof setInterval> | undefined;

export function stopAlerts(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export function startAlerts(notify: Notify, intervalMs = SWEEP_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepAlerts(notify).catch((e) => log.warn("alerts.sweep-failed", { error: errMsg(e) }));
  }, intervalMs);
  log.info("alerts.started", { intervalMs });
}

/** One pass over all subscribers. Exported so it can be driven directly in tests. */
export async function sweepAlerts(notify: Notify, now = Date.now()): Promise<void> {
  for (const { telegramId, prefs } of store.alertSubscribers()) {
    const user = getUser(telegramId);
    if (!user) continue;
    // Per-user isolation: one user's RPC failure never blocks the rest.
    try { if (prefs.trove) await checkTrove(telegramId, user.address, notify, now); } catch (e) { log.warn("alerts.trove-failed", { error: errMsg(e) }); }
    try { if (prefs.rewards) await checkRewards(telegramId, user.address, notify, now); } catch (e) { log.warn("alerts.rewards-failed", { error: errMsg(e) }); }
    try { if (prefs.epoch) await checkEpoch(telegramId, user.address, notify, now); } catch (e) { log.warn("alerts.epoch-failed", { error: errMsg(e) }); }
  }
}

async function checkTrove(telegramId: number, owner: `0x${string}`, notify: Notify, now: number): Promise<void> {
  const trove = await readTrove(owner);
  if (!trove || trove.debtMUSD <= 0 || trove.collBTC <= 0) return;
  const price = await btcPriceUsd();
  if (!price) return;
  const icr = ((trove.collBTC * price) / trove.debtMUSD) * 100;
  if (icr >= TROVE_WARN_ICR) {
    // Healthy again — clear the BAND, keep the timestamp.
    //
    // Clearing the band is right: crossing back above the threshold is a real
    // state change, so a fresh dip is genuinely new information and should not
    // be suppressed for 24h (the original bug suppressed exactly that).
    //
    // But clearing `troveAt` as well left NO floor on how often we may re-alert,
    // and with 30-minute sweeps a ratio oscillating across 150% produced an
    // alert every other sweep. Keeping the timestamp preserves a minimum
    // re-alert interval across the recovery, which is what stops the spam
    // without hiding a real dip.
    const st = store.alertState(telegramId);
    if (st.troveICR !== undefined) store.patchAlertState(telegramId, { troveICR: undefined });
    return;
  }
  const st = store.alertState(telegramId);
  const cooledDown = !st.troveAt || now - st.troveAt > DAY_MS;
  // A FIRST observation below the threshold must alert. Requiring a previous
  // band made a fast crash (149% → 111%) inside the cooldown window completely
  // silent — the half of this that costs someone their collateral.
  const firstBelow = st.troveICR === undefined;
  const droppedBand = st.troveICR !== undefined && icr <= st.troveICR - TROVE_REALERT_DROP;
  // ...but never more often than this, whatever the band did.
  const rateOk = !st.troveAt || now - st.troveAt >= MIN_REALERT_MS;
  if (!rateOk) return;
  if (!cooledDown && !droppedBand && !firstBelow) return;

  // Live MCR, not a hardcoded 1.1 — the same parameter the borrow card uses.
  const p = await musdParams();
  const mcr = p ? Number(p.mcr) / 1e18 : 1.1;
  const liqPrice = (mcr * trove.debtMUSD) / trove.collBTC;
  await notify(
    telegramId,
    `⚠️ Trove health warning\n\n` +
      `Your collateral ratio is ~${icr.toFixed(0)}% (warning threshold ${TROVE_WARN_ICR}%).\n` +
      `If BTC falls below ~$${Math.round(liqPrice).toLocaleString()} (now ~$${Math.round(price).toLocaleString()}), your Trove can be liquidated: ` +
      `the debt is cleared but the collateral is taken, and a liquidator keeps a cut of it.\n\n` +
      `To make it safer, send:\n"add 0.01 BTC collateral"  or  "repay 200 MUSD"`,
  );
  store.patchAlertState(telegramId, { troveAt: now, troveICR: icr });
}

async function checkRewards(telegramId: number, owner: `0x${string}`, notify: Notify, now: number): Promise<void> {
  const st = store.alertState(telegramId);
  if (st.rewardsAt && now - st.rewardsAt < DAY_MS) return;
  let claimable = false;
  try {
    const plan = await buildClaim({ action: "claim", scope: "all" }, owner);
    claimable = plan.executable && plan.steps.length > 0;
  } catch {
    return; // "Nothing claimable" throws — that's the quiet path.
  }
  if (!claimable) return;
  await notify(
    telegramId,
    `🌾 You have unclaimed rewards waiting.\n\n` +
      `Most holders never claim - you opted in to be reminded. Claiming is free of agent fees.\n\n` +
      `Send: "claim all"`,
  );
  store.patchAlertState(telegramId, { rewardsAt: now });
}

async function checkEpoch(telegramId: number, owner: `0x${string}`, notify: Notify, now: number): Promise<void> {
  const remaining = msToEpochFlip(now);
  if (remaining > DAY_MS) return; // only in the final 24h
  const mark = epochStartMs(now);
  if (store.alertState(telegramId).epochMark === mark) return; // once per epoch
  const nfts = await ownedVeNfts(owner);
  if (nfts.length === 0) return; // no voting power — no noise
  const hours = Math.max(1, Math.round(remaining / 3_600_000));
  await notify(
    telegramId,
    `🗳️ Epoch closes in ~${hours}h - your veNFT vote isn't locked in for nothing.\n\n` +
      `Votes persist across epochs, but re-voting optimally captures this epoch's live incentives.\n\n` +
      `Send: "vote optimally with veNFT ${nfts[0]}"`,
  );
  store.patchAlertState(telegramId, { epochMark: mark });
}
