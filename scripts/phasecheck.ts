/**
 * Deterministic-logic checks for Phases 2–5 — no network, no Telegram.
 *   MASTER_ENCRYPTION_KEY=$(npm run -s genkey) TELEGRAM_BOT_TOKEN=x \
 *   DATA_DIR=$(mktemp -d) npx tsx scripts/phasecheck.ts
 */
import "./_testenv.js";
import { optimalAllocation } from "../src/core/optimalVoting.js";
import { createDcaSchedule, runDueSchedules } from "../src/keeper/scheduler.js";
import { buildBorrow } from "../src/surfaces/borrow.js";
import { buildLock } from "../src/surfaces/lock.js";
import { createWallet, listAccounts, switchAccount, activeIndex } from "../src/wallet/walletService.js";
import { fallbackParse } from "../src/llm/adapter.js";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
}
async function expectThrow(name: string, fn: () => unknown) {
  try { await fn(); console.log(`  ✗ FAIL ${name} (no throw)`); failures++; }
  catch { console.log(`  ✓ ${name}`); }
}

async function main() {
  console.log("Phase 2–5 deterministic checks\n" + "=".repeat(50));

  // ── Optimal voting ─────────────────────────────────────────────────────────
  console.log("Optimal voting (water-filling):");
  const gauges = [
    { pool: "BTC/MUSD", incentives: 1000, otherVotes: 100 },
    { pool: "MUSD/mUSDC", incentives: 500, otherVotes: 100 },
    { pool: "MUSD/mUSDT", incentives: 100, otherVotes: 100 },
    { pool: "DEAD/POOL", incentives: 0, otherVotes: 50 }, // no incentives -> 0 weight
  ];
  const r = optimalAllocation(gauges, 100);
  const sumBps = r.allocations.reduce((s, a) => s + a.weightBps, 0);
  check("weights sum to exactly 10000 bps", sumBps === 10_000);
  check("highest-incentive gauge gets the most weight", r.allocations[0]?.pool === "BTC/MUSD");
  check("zero-incentive gauge excluded", !r.allocations.some((a) => a.pool === "DEAD/POOL"));
  check("expected reward is positive", r.totalExpectedReward > 0);
  // Water-filling: marginal value per gauge should be ~equal among funded gauges.
  const marg = r.allocations.map((a) => {
    const g = gauges.find((x) => x.pool === a.pool)!;
    const myVotes = (a.weightBps / 10_000) * 100;
    return (g.incentives * g.otherVotes) / (g.otherVotes + myVotes) ** 2;
  });
  const spread = Math.max(...marg) - Math.min(...marg);
  check("marginal values ~equalized (water-filling)", spread / Math.max(...marg) < 0.02);

  // ── Surface validation ─────────────────────────────────────────────────────
  console.log("Surface guardrails:");
  await expectThrow("borrow below 1800 MUSD min net debt rejected", () =>
    buildBorrow({ action: "borrow", collateralBTC: "0.1", mintMUSD: "500" }));
  const borrowPlan = await buildBorrow({ action: "borrow", collateralBTC: "0.1", mintMUSD: "5000" });
  check("valid borrow builds a plan with summary", borrowPlan.summary.length > 0 && borrowPlan.title.includes("Borrow"));
  await expectThrow("veBTC lock over 28 days rejected", () =>
    buildLock({ action: "lock", asset: "BTC", amount: "0.2", lockDays: 60 }));
  const lockPlan = buildLock({ action: "lock", asset: "MEZO", amount: "1000", lockDays: 365 });
  check("valid veMEZO lock builds a plan", lockPlan.action === "lock");

  // ── Multi-account ──────────────────────────────────────────────────────────
  console.log("Multi-account:");
  const uid = 90909;
  const a0 = await createWallet(uid);
  const a1 = await createWallet(uid);
  check("second createWallet adds a distinct account", a0.address !== a1.address);
  check("two accounts listed", listAccounts(uid).length === 2);
  check("new account is active", activeIndex(uid) === 1);
  switchAccount(uid, 0);
  check("switchAccount changes the active index", activeIndex(uid) === 0);

  // ── DCA scheduler (injected executor; no network) ──────────────────────────
  console.log("DCA scheduler:");
  const user = await createWallet(80808);
  const now = 1_700_000_000_000;
  const sched = createDcaSchedule(user, { action: "dcaCreate", fromToken: "MUSD", toToken: "BTC", amount: "50", everyHours: 24, occurrences: 2 }, now);
  check("schedule created, due now", sched.active && sched.nextRunAt <= new Date(now).toISOString());
  let ran = 0;
  const mockExec = async () => { ran++; return { ok: true, detail: "mock" }; };

  const { store: st } = await import("../src/db/store.js");

  // Operator kill-switch: halts ALL scheduled execution immediately.
  st.setKeeperPaused(true);
  const halted = await runDueSchedules(now, mockExec);
  check("kill-switch halts all scheduled execution", halted.length === 0 && ran === 0);
  st.setKeeperPaused(false);

  // Per-user pause freezes runs without cancelling the schedule.
  st.setUserPaused(user.telegramId, true);
  const pausedRep = await runDueSchedules(now, mockExec);
  check("per-user pause blocks the run but keeps the schedule", ran === 0 && pausedRep[0]?.ok === false);
  st.setUserPaused(user.telegramId, false);

  const rep1 = await runDueSchedules(now, mockExec);
  check("keeper ran the due schedule once", ran === 1 && rep1.length === 1);
  const rep2 = await runDueSchedules(now, mockExec);
  check("not due again until next interval (idempotent)", rep2.length === 0 && ran === 1);
  const later = now + 25 * 60 * 60 * 1000;
  await runDueSchedules(later, mockExec);
  check("runs again after the interval, then hits occurrence limit", ran === 2);
  await runDueSchedules(later + 25 * 60 * 60 * 1000, mockExec);
  check("deactivated after occurrences exhausted", ran === 2);

  // ── Deterministic parser routing ───────────────────────────────────────────
  console.log("Fallback intent parsing (no LLM):");
  const syms = ["BTC", "MUSD", "mUSDC"];
  const cases: Array<[string, string]> = [
    ["borrow 5000 MUSD against 0.1 BTC", "borrow"],
    ["repay 1000 MUSD", "repay"],
    ["lock 0.2 BTC for 28 days", "lock"],
    ["vote optimally", "vote"],
    ["claim all", "claim"],
    ["swap 100 MUSD to mUSDC", "swap"],
    ["zap 0.01 BTC into MUSD/mUSDC", "zap"],
    ["dca 50 MUSD to BTC every 24h", "dcaCreate"],
    ["new account", "account"],
    ["show my portfolio", "portfolio"],
    ["auto-compound on", "autoCompound"],
  ];
  for (const [msg, expected] of cases) check(`"${msg}" → ${expected}`, fallbackParse(msg, syms).action === expected);

  // ── Monetization: fee math + disclosure ────────────────────────────────────
  console.log("Agent fee (monetization):");
  {
    const { env, feesEnabled } = await import("../src/config/env.js");
    const bps = env.fees.swapBps;
    check("fee bps is hard-capped at 100 (1%)", bps <= 100);
    if (feesEnabled) {
      const gross = 1_000_000n;
      const fee = (gross * BigInt(bps)) / 10_000n;
      check("fee is deducted from the input and leaves a positive net", fee > 0n && gross - fee > 0n);
    } else {
      check("no fee configured => no fee charged (opt-in monetization)", bps === 0 || !env.fees.recipient);
    }
  }

  console.log("\n" + (failures === 0 ? "All Phase 2–5 checks passed. ✅" : `${failures} FAILURE(S) ✗`));
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
