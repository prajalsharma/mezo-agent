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
/** A schedule that fails this many times in a row is broken, not unlucky. */
const MAX_CONSECUTIVE_FAILURES = 5;

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

export type RunReport = {
  id: string; ok: boolean; detail: string;
  /** Occurrences left AFTER accounting for this run. */
  remaining?: number;
  /** False when this run ended the schedule. */
  active?: boolean;
  /** Set when the schedule stopped, with the reason, so the user is told. */
  stopped?: string;
};

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
    try {
      await runOne(s, now, executor, reports);
    } catch (e) {
      // One malformed schedule must not take the whole tick down with it.
      log.error("keeper.schedule-failed", { id: s.id, error: errMsg(e) });
      reports.push({ id: s.id, ok: false, detail: "internal error; skipped this run" });
    }
  }
  return reports;
}

async function runOne(
  s: DcaSchedule, now: number, executor: SwapExecutor, reports: RunReport[],
): Promise<void> {
  {
    // Per-user pause: a user can freeze their own automation without cancelling.
    if (store.isUserPaused(s.telegramId)) {
      reports.push({ id: s.id, ok: false, detail: "paused by user" });
      return;
    }

    // CLAIM THE TIME SLOT — AND ONLY THE TIME SLOT — BEFORE RUNNING IT.
    //
    // nextRunAt used to advance only AFTER the executor resolved, so for the
    // whole duration of a slow swap the schedule stayed selectable by
    // dueSchedules and an overlapping tick ran it again. Claiming the slot first
    // fixes that: a concurrent selection sees a future nextRunAt and skips it.
    //
    // The OCCURRENCE COUNT is deliberately not claimed here. Decrementing
    // `remaining` up front meant every failure burned a run: "dca … for 4 times"
    // against an underfunded wallet died after four intervals having executed
    // ZERO swaps, went active:false, and vanished from the user's /dca list with
    // no way to resume it. Any executor failure did it — a balance shortfall, a
    // cap rejection, an RPC blip, a receipt timeout. An occurrence is what the
    // user bought; it is spent only when a swap actually goes out.
    //
    // The cadence is computed from the slot that was DUE, not from the wall
    // clock, so a late tick doesn't permanently drag the schedule later. If the
    // process was down long enough to miss several intervals, we skip forward to
    // the next future slot rather than firing a burst of catch-up trades.
    const nextRunAt = nextSlot(s.nextRunAt, s.everyHours, now);
    store.updateSchedule(s.id, { nextRunAt });

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

    // Account for the run only now that we know what happened.
    let remaining = s.remaining;
    let stillActive = s.active;
    let stopped: string | undefined;
    if (ok) {
      remaining = s.remaining < 0 ? -1 : s.remaining - 1;
      if (remaining === 0) { stillActive = false; stopped = "all runs completed"; }
      store.updateSchedule(s.id, { remaining, active: stillActive, failures: 0 });
    } else {
      // A schedule that can NEVER succeed must still stop, or it retries forever
      // and notifies on every interval. Consecutive failures are the honest
      // signal for that — unlike an occurrence, they reset the moment one works.
      const failures = (s.failures ?? 0) + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        stillActive = false;
        stopped = `stopped after ${failures} consecutive failures`;
      }
      store.updateSchedule(s.id, { failures, active: stillActive });
    }

    reports.push({ id: s.id, ok, detail, remaining, active: stillActive, stopped });
    log.info("keeper.dca.run", { id: s.id, ok, remaining, active: stillActive });
  }
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
  // A non-finite value from a corrupted record propagates through Math.max and
  // makes `new Date(NaN).toISOString()` throw RangeError — which escaped
  // runDueSchedules and abandoned every OTHER user's schedule on that tick.
  const hours = Number.isFinite(everyHours) ? everyHours : MIN_INTERVAL_HOURS;
  const interval = Math.max(MIN_INTERVAL_HOURS, hours) * HOUR_MS;
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
/** The tick currently running, so shutdown can wait for it. */
let inFlight: Promise<unknown> | undefined;

/** Start the keeper loop (called at startup when KEEPER_ENABLED=true). */
export type KeeperNotify = (telegramId: number, text: string) => Promise<void>;

export function startKeeper(intervalMs = 60_000, notify?: KeeperNotify): void {
  if (timer) return;
  timer = setInterval(() => {
    const tick = runDueSchedules()
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
          // Say what is TRUE of the schedule after this run. The failure message
          // used to promise "it will try again at …" unconditionally, so a run
          // that ended the schedule told the user it would retry — and, because
          // the occurrence had already been consumed, "0 run(s) left" alongside
          // it. Report the stop, and only promise a retry when one is coming.
          const left = s.remaining < 0 ? "runs until you cancel" : `${s.remaining} run(s) left`;
          let text: string;
          if (r.ok) {
            text = `🔁 DCA executed: ${what}\n${r.detail.startsWith("0x") ? `tx ${r.detail}\n` : ""}` +
              (r.active === false
                ? `That was the last scheduled run - this DCA is now complete.`
                : `Next: ${new Date(s.nextRunAt).toUTCString()} (${left}).\nSay "cancel dca ${r.id}" to stop.`);
          } else if (r.active === false) {
            text = `🛑 DCA stopped: ${what}\nReason: ${r.detail}\n` +
              `${r.stopped ?? "the schedule was ended"}. No further runs will happen - ` +
              `create a new schedule once the cause is fixed.`;
          } else {
            text = `⚠️ DCA skipped: ${what}\nReason: ${r.detail}\n` +
              `This did NOT use up one of your scheduled runs. It will try again at ` +
              `${new Date(s.nextRunAt).toUTCString()}. Say "cancel dca ${r.id}" to stop.`;
          }
          await notify(s.telegramId, text).catch((e) => log.warn("keeper.notify-failed", { error: errMsg(e) }));
        }
      })
      .catch((e) => log.warn("keeper.tick-failed", { error: String(e) }))
      .finally(() => { if (inFlight === tick) inFlight = undefined; });
    inFlight = tick;
  }, intervalMs);
  log.info("keeper.started", { intervalMs });
}

/**
 * Stop the loop AND wait for a tick that is already running.
 *
 * Clearing the interval alone left an in-flight run to be killed by the
 * `process.exit(0)` that follows — and since the slot is claimed before the
 * executor, that run is skipped rather than retried. Awaiting it means a
 * redeploy either completes the swap or has not started one.
 */
export async function stopKeeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (inFlight) {
    log.info("keeper.awaiting-inflight-tick");
    await inFlight.catch(() => {});
  }
}
