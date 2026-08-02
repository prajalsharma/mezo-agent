import { store, type DcaSchedule, type UserRecord } from "../db/store.js";
import { env } from "../config/env.js";
import { registry } from "../registry/registry.js";
import { buildSwap } from "../surfaces/swap/swapBuilder.js";
import { executeSwap } from "../surfaces/swap/swapService.js";
import { log } from "../core/log.js";
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
 *   • IDEMPOTENT — `nextRunAt` advances only after a run is accounted for, and a
 *     global kill-switch (KEEPER_ENABLED=false) pauses everything.
 */

const HOUR_MS = 60 * 60 * 1000;

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
  const referral = referralFor(user.telegramId, user.address);
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

  const nowIso = new Date(now).toISOString();
  const due = store.dueSchedules(nowIso);
  const reports: RunReport[] = [];

  for (const s of due) {
    // Per-user pause: a user can freeze their own automation without cancelling.
    if (store.isUserPaused(s.telegramId)) {
      reports.push({ id: s.id, ok: false, detail: "paused by user" });
      continue;
    }
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

    // Advance idempotently: next run is one interval out; decrement occurrences.
    const next = new Date(now + s.everyHours * HOUR_MS).toISOString();
    const remaining = s.remaining < 0 ? -1 : s.remaining - 1;
    store.updateSchedule(s.id, {
      nextRunAt: next,
      remaining,
      active: remaining === 0 ? false : s.active,
    });
    reports.push({ id: s.id, ok, detail });
    log.info("keeper.dca.run", { id: s.id, ok, remaining });
  }
  return reports;
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Start the keeper loop (called at startup when KEEPER_ENABLED=true). */
export function startKeeper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runDueSchedules().catch((e) => log.warn("keeper.tick-failed", { error: String(e) }));
  }, intervalMs);
  log.info("keeper.started", { intervalMs });
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
