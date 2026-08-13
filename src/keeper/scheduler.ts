import { store, type DcaSchedule, type UserRecord } from "../db/store.js";
import { env } from "../config/env.js";
import { registry } from "../registry/registry.js";
import { buildSwap } from "../surfaces/swap/swapBuilder.js";
import { executeSwap } from "../surfaces/swap/swapService.js";
import { log, errMsg } from "../core/log.js";
import { referralFor } from "../core/referral.js";
import type { DcaCreateIntent } from "../llm/intent.js";

/**
 * Keeper for pre-authorized automation (DCA + epoch auto-compound). Scheduled
 * actions are:
 *   • PRE-AUTHORIZED — the user confirmed the schedule's parameters on creation,
 *   • SCOPED — each run still passes through the signer's caps/allowlist (and, for
 *     a smart account, the on-chain session-key limits), so a schedule can never
 *     exceed what a manual action could,
 *   • REVOCABLE — /dca cancel flips `active=false` immediately,
 *   • IDEMPOTENT — the slot is CLAIMED (nextRunAt advanced) before the executor
 *     runs, and overlapping ticks are refused outright. It used to be the other
 *     way around, and the comment here claimed that was what made it idempotent;
 *     in fact it was exactly what let a slow run execute two or three times.
 *   • BOUNDED — a global kill-switch (KEEPER_ENABLED=false) pauses everything,
 *     and no schedule may run more often than once an hour.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Below this the keeper cannot pace itself: the tick is 60s and a run can take minutes. */
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 365;

export class ScheduleError extends Error {}

/** Create a DCA schedule after validating tokens + params. Does not run it. */
export function createDcaSchedule(user: UserRecord, intent: DcaCreateIntent, now = Date.now()): DcaSchedule {
  if (!registry.tryToken(intent.fromToken) || !registry.tryToken(intent.toToken)) {
    throw new ScheduleError(`Unknown token. Known: ${registry.knownTokenSymbols().join(", ")}.`);
  }
  if (intent.fromToken.toLowerCase() === intent.toToken.toLowerCase()) {
    throw new ScheduleError("From and to tokens must differ.");
  }
  if (Number(intent.amount) <= 0) throw new ScheduleError("Amount must be greater than zero.");

  // The interval. This is the most important validation in the file and it did
  // not exist: `everyHours: 0` produced nextRunAt = now, and after each run
  // `now + 0` — still due. The schedule fired on EVERY 60s tick, forever, which
  // is roughly 1,440 unattended swaps a day from one typed message. The Zod
  // schema does require a positive integer, but the deterministic rule parser
  // returned before validation, so nothing enforced it on the path users
  // actually took. Both holes are closed now; this is the one that matters,
  // because it is the last line of defence before an unattended signer.
  if (!Number.isInteger(intent.everyHours) || intent.everyHours < MIN_INTERVAL_HOURS) {
    throw new ScheduleError(
      `The interval must be a whole number of hours, at least ${MIN_INTERVAL_HOURS}. ` +
        `An interval of ${intent.everyHours} would run continuously.`,
    );
  }
  if (intent.everyHours > MAX_INTERVAL_HOURS) {
    throw new ScheduleError(`The longest interval I can schedule is ${MAX_INTERVAL_HOURS} hours (about a year).`);
  }
  if (intent.occurrences !== undefined && (!Number.isInteger(intent.occurrences) || intent.occurrences < 1)) {
    throw new ScheduleError("Occurrences must be a whole number of runs, at least 1.");
  }

  const schedule: DcaSchedule = {
    id: store.newId(),
    telegramId: user.telegramId,
    accountAddress: user.address,
    fromToken: registry.token(intent.fromToken).symbol,
    toToken: registry.token(intent.toToken).symbol,
    amount: intent.amount,
    everyHours: intent.everyHours,
    remaining: intent.occurrences ?? -1, // -1 = unbounded
    nextRunAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString(),
    active: true,
  };
  store.addSchedule(schedule);
  return schedule;
}

export type RunReport = { id: string; ok: boolean; detail: string };

/** Executor seam so the keeper is testable without the network. */
export type SwapExecutor = (user: UserRecord, s: DcaSchedule) => Promise<{ ok: boolean; detail: string }>;

const liveExecutor: SwapExecutor = async (user, s) => {
  const tokenIn = registry.token(s.fromToken);
  const tokenOut = registry.token(s.toToken);
  // Referral parity for scheduled swaps (audit: DCA previously bypassed referral
  // entirely — referred users were over-charged and referrers earned nothing on
  // exactly the recurring flow that matters most).
  const referral = await referralFor(user.telegramId, user.address);
  const plan = await buildSwap({ owner: user.address, tokenIn, tokenOut, humanAmountIn: s.amount, slippagePct: 0.5, referral });
  if (!plan.executable) return { ok: false, detail: plan.gatedReason ?? "swap execution gated" };
  const res = await executeSwap(user, plan);
  // Ledger the referrer's cut when it settled (same rules as the interactive path).
  const rp = plan.referralPaid;
  const settled =
    rp && rp.amount > 0n &&
    res.outcomes.some((o) => o.ok && (plan.steps.some((st) => st.kind === "referral") ? o.kind === "referral" : o.kind === "swap"));
  if (settled) store.recordReferralEarning(rp.referrerTelegramId, rp.symbol, rp.amount);
  return res.aborted ? { ok: false, detail: "swap aborted" } : { ok: true, detail: res.finalHash ?? "submitted" };
};

/**
 * Is a tick already running? A DCA swap waits on receipts (up to 180s each,
 * and a plan can hold several), while the timer fires every 60s — so one slow
 * run could still be in flight for three or more ticks. Each of those ticks
 * re-selected the same still-due schedule and executed it AGAIN: several
 * on-chain swaps, and several fees, for one authorised run.
 */
let ticking = false;

/**
 * Run every schedule that is due. Advances nextRunAt and decrements occurrences
 * regardless of whether the swap could execute (so a gated deployment doesn't
 * spin), but only counts a run as spent once. Returns a per-schedule report.
 */
export async function runDueSchedules(
  now = Date.now(),
  executor: SwapExecutor = liveExecutor,
): Promise<RunReport[]> {
  // Emergency kill-switch, re-checked on EVERY tick (not just at startup) so
  // flipping it halts all scheduled execution immediately, and a stray direct
  // call can't bypass it. Global env switch OR the runtime pause.
  if (!env.keeperEnabled || store.isKeeperPaused()) {
    log.warn("keeper.halted", { envEnabled: env.keeperEnabled, paused: store.isKeeperPaused() });
    return [];
  }
  if (ticking) {
    log.warn("keeper.tick-overlap-skipped");
    return [];
  }
  ticking = true;
  try {
    return await runDueSchedulesInner(now, executor);
  } finally {
    ticking = false;
  }
}

async function runDueSchedulesInner(now: number, executor: SwapExecutor): Promise<RunReport[]> {
  const nowIso = new Date(now).toISOString();
  const due = store.dueSchedules(nowIso);
  const reports: RunReport[] = [];

  for (const s of due) {
    // Per-user pause: a user can freeze their own automation without cancelling.
    if (store.isUserPaused(s.telegramId)) {
      reports.push({ id: s.id, ok: false, detail: "paused by user" });
      continue;
    }

    // CLAIM THE SLOT BEFORE RUNNING IT.
    //
    // nextRunAt used to advance only AFTER the executor resolved, so for the
    // whole duration of a slow swap the schedule stayed selectable by
    // dueSchedules. Claiming first means a concurrent or overlapping selection
    // sees a future nextRunAt and skips it. The cost of claiming first is that a
    // crash mid-run skips one interval instead of repeating it — the right way
    // round for something that spends money without a human present.
    //
    // The cadence is computed from the slot that was DUE, not from the wall
    // clock, so a late tick doesn't permanently drag the schedule later. If the
    // process was down long enough to miss several intervals, we skip forward to
    // the next future slot rather than firing a burst of catch-up trades.
    const nextRunAt = nextSlot(s.nextRunAt, s.everyHours, now);
    const remaining = s.remaining < 0 ? -1 : s.remaining - 1;
    store.updateSchedule(s.id, {
      nextRunAt,
      remaining,
      active: remaining === 0 ? false : s.active,
    });

    const user = store.listAccounts(s.telegramId).find((u) => u.address.toLowerCase() === s.accountAddress.toLowerCase());
    let detail = "no matching account";
    let ok = false;
    if (user) {
      try {
        const r = await executor(user, s);
        ok = r.ok;
        detail = r.detail;
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
    }

    reports.push({ id: s.id, ok, detail });
    log.info("keeper.dca.run", { id: s.id, ok, remaining });
  }
  return reports;
}

/**
 * The next run time on the schedule's ORIGINAL cadence that is strictly in the
 * future. Anchoring on `previous + interval` (rather than on the tick's own
 * clock) keeps an hourly schedule hourly instead of drifting a little later
 * every run; skipping straight past missed slots keeps a restart after downtime
 * from firing a burst of back-to-back trades.
 *
 * Exported for tests.
 */
export function nextSlot(previousIso: string, everyHours: number, now: number): string {
  const interval = Math.max(MIN_INTERVAL_HOURS, everyHours) * HOUR_MS;
  const previous = Date.parse(previousIso);
  let next = Number.isFinite(previous) ? previous + interval : now + interval;
  if (next <= now) {
    // Jump to the first slot after `now` in one step, not in a loop.
    const missed = Math.ceil((now - next) / interval);
    next += missed * interval;
    if (next <= now) next += interval;
  }
  return new Date(next).toISOString();
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Start the keeper loop (called at startup when KEEPER_ENABLED=true). */
export type KeeperNotify = (telegramId: number, text: string) => Promise<void>;

export function startKeeper(intervalMs = 60_000, notify?: KeeperNotify): void {
  if (timer) return;
  timer = setInterval(() => {
    void runDueSchedules()
      .then(async (reports) => {
        // TELL THE USER. A scheduled trade that executes in silence is
        // indistinguishable from one that never ran - the reports used to be
        // discarded here, so DCA looked broken even when it worked. The bounty
        // also requires scheduled actions be observable.
        if (!notify) return;
        for (const r of reports) {
          const s = store.scheduleById(r.id);
          if (!s) continue;
          const what = `${s.amount} ${s.fromToken} → ${s.toToken}`;
          const left = s.remaining < 0 ? "runs until you cancel" : `${s.remaining} run(s) left`;
          const text = r.ok
            ? `🔁 DCA executed: ${what}\n${r.detail.startsWith("0x") ? `tx ${r.detail}\n` : ""}Next: ${new Date(s.nextRunAt).toUTCString()} (${left}).\nSay "cancel dca ${r.id}" to stop.`
            : `⚠️ DCA skipped: ${what}\nReason: ${r.detail}\nIt will try again at ${new Date(s.nextRunAt).toUTCString()}. Say "cancel dca ${r.id}" to stop.`;
          await notify(s.telegramId, text).catch((e) => log.warn("keeper.notify-failed", { error: errMsg(e) }));
        }
      })
      .catch((e) => log.warn("keeper.tick-failed", { error: String(e) }));
  }, intervalMs);
  log.info("keeper.started", { intervalMs });
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
