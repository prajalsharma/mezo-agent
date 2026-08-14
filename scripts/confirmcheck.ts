export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Is the plan the user approved the plan that gets signed? And is unattended
 * automation actually bounded?
 *
 * Both were structural defects rather than typos, so both deserve a test that
 * would fail again if the structure regressed:
 *
 *  • There was ONE pending slot per user, overwritten unconditionally, and the
 *    confirm buttons were CONSTANT strings ("swap:confirm") carrying no plan
 *    identity. A user could see card A, have plan B silently replace it, tap
 *    Confirm on A, and sign B. Nothing about that was detectable from the card.
 *
 *  • "dca … every 0 hours" was reachable, because the deterministic rule parser
 *    returned before Zod validation. nextRunAt = now + 0 is always due, so the
 *    schedule fired on every 60s tick forever — ~1,440 unattended swaps a day
 *    from one typed message.
 *
 *   npx tsx scripts/confirmcheck.ts
 */
import {
  setPending, takePending, getPending, clearPending, refusalText,
} from "../src/bot/session.js";
import { createDcaSchedule, ScheduleError, nextSlot } from "../src/keeper/scheduler.js";
import { parseIntent } from "../src/llm/adapter.js";
import { registry } from "../src/registry/registry.js";
import type { UserRecord } from "../src/db/store.js";

let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};

const UID = 4242;
const plan = (title: string) => ({
  action: "swap", title, summary: [], warnings: [], steps: [],
  allowedTargets: [], executable: true, nativeValue: 0n,
}) as never;

console.log("Confirmation boundary\n");
{
  clearPending(UID);
  const idA = setPending(UID, { kind: "action", plan: plan("PLAN A") }, "0xowner");
  const idB = setPending(UID, { kind: "action", plan: plan("PLAN B") }, "0xowner");
  ok("each card gets a distinct id", idA !== idB, `${idA} vs ${idB}`);

  // THE finding: tapping the older card must not execute the newer plan.
  const stale = takePending(UID, idA);
  ok("a tap on the SUPERSEDED card is refused", !stale.ok && stale.why === "superseded");
  ok("the refusal explains what happened", /replaced by a newer one/.test(refusalText("superseded")));

  // ...and the live plan is still intact, so a stale tap can't disarm it either.
  const live = takePending(UID, idB);
  ok("the current plan survives a stale tap", live.ok && (live.pending as never as { plan: { title: string } }).plan.title === "PLAN B");
}
{
  clearPending(UID);
  const id = setPending(UID, { kind: "action", plan: plan("ONCE") }, "0xowner");
  const first = takePending(UID, id);
  const second = takePending(UID, id);
  ok("a plan can be claimed exactly ONCE (double-tap race)", first.ok && !second.ok);
  ok("the second tap says nothing is pending", !second.ok && second.why === "none");
}
{
  clearPending(UID);
  const id = setPending(UID, { kind: "action", plan: plan("ACCT") }, "0xAccountOne");
  const taken = takePending(UID, id);
  ok("the plan records which account it was built for",
    taken.ok && taken.pending.accountAddress === "0xAccountOne");
}
{
  clearPending(UID);
  setPending(UID, { kind: "action", plan: plan("GUESS") }, "0xowner");
  const guessed = takePending(UID, "obviously-not-the-id");
  ok("a guessed id does not claim the plan", !guessed.ok);
  ok("...and the plan is still there afterwards", getPending(UID) !== undefined);
  clearPending(UID);
}

console.log("\nAutomation bounds\n");
const user = { telegramId: UID, address: "0x0000000000000000000000000000000000000001" } as unknown as UserRecord;
const syms = registry.knownTokenSymbols();
const from = syms.find((s) => s.toUpperCase() === "MUSD") ?? syms[0]!;
const to = syms.find((s) => s.toUpperCase().includes("BTC")) ?? syms[1]!;

const rejects = (everyHours: number, occurrences?: number) => {
  try {
    createDcaSchedule(user, { action: "dcaCreate", fromToken: from, toToken: to, amount: "1", everyHours, occurrences } as never);
    return false;
  } catch (e) {
    return e instanceof ScheduleError;
  }
};
ok("everyHours = 0 is REFUSED (fired every tick, forever)", rejects(0));
ok("a negative interval is refused", rejects(-1));
ok("a fractional interval is refused", rejects(0.5));
ok("an absurd interval is refused", rejects(24 * 365 * 10));
ok("zero occurrences is refused", rejects(24, 0));
ok("a sane hourly schedule is still accepted", !rejects(1));

// The parser must not hand a zero interval to the scheduler in the first place.
{
  const parsed = await parseIntent(`dca 50 ${from} into ${to} every 0 hours`, syms);
  ok("the parser refuses to emit a zero-interval DCA at all",
    parsed.action !== "dcaCreate",
    `got action=${parsed.action}`);
}

// Cadence must anchor on the schedule, not on the tick's own clock, or an
// hourly DCA drifts a little later on every single run.
{
  const t0 = Date.parse("2026-08-14T12:00:00.000Z");
  const late = t0 + 90_000; // the tick fired 90s late
  ok("the next slot anchors on the schedule, not the late tick",
    nextSlot(new Date(t0).toISOString(), 1, late) === new Date(t0 + 3_600_000).toISOString(),
    nextSlot(new Date(t0).toISOString(), 1, late));

  // After downtime, skip forward — never fire a burst of catch-up trades.
  const muchLater = t0 + 10 * 3_600_000 + 60_000;
  const next = Date.parse(nextSlot(new Date(t0).toISOString(), 1, muchLater));
  ok("after long downtime it skips ahead instead of firing a burst",
    next > muchLater && next - muchLater <= 3_600_000,
    new Date(next).toISOString());
}

console.log(fail === 0 ? "\nConfirmation + automation bounds OK. ✅" : `\n${fail} FAILURE(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
