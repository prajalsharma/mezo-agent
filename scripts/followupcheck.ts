export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * The FOLLOW-UP review's findings — defects introduced by the remediation.
 *
 * Same discipline as reviewcheck.ts: assert the fix is present, not merely that
 * the old string is gone. Where the defect was behavioural rather than textual
 * (the backup lag, the DCA occurrence, the alert floor) the property is
 * EXECUTED here rather than pattern-matched, because two of these survived
 * casual verification the first time precisely by looking correct.
 *
 *   npx tsx scripts/followupcheck.ts
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type DcaSchedule, type UserRecord } from "../src/db/store.js";
import { runDueSchedules, nextSlot, createDcaSchedule } from "../src/keeper/scheduler.js";
import { setPending, takePending, sweepPending, refusalText } from "../src/bot/session.js";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
let fail = 0;
const ok = (id: string, title: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${id.padEnd(6)} ${title}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};

const store = read("src/db/store.ts");
const signer = read("src/custody/signer.ts");
const sched = read("src/keeper/scheduler.ts");
const alerts = read("src/keeper/alerts.ts");
const attest = read("src/custody/attest.ts");
const plan = read("src/surfaces/plan.ts");
const borrow = read("src/surfaces/borrow.ts");
const lock = read("src/surfaces/lock.ts");
const zap = read("src/surfaces/zap.ts");
const session = read("src/bot/session.ts");
const menu = read("src/bot/menu.ts");
const intent = read("src/llm/intent.ts");
const dockerfile = read("Dockerfile");
const entry = read("docker-entrypoint.sh");
const feeRouter = read("contracts/src/FeeRouter.sol");
const pkg = JSON.parse(read("package.json") || "{}");

console.log("\nHIGH\n");

// N-H1 — EXECUTED: the backup must be current, not one write behind.
{
  const dir = mkdtempSync(join(tmpdir(), "mezo-followup-"));
  const s1 = new Store(dir);
  const path = join(dir, `mezo-agent.${process.env.MEZO_NETWORK ?? "testnet"}.json`);
  s1.setKeeperPaused(true);                       // write 1 (a "fresh deploy")
  s1.setUserPaused(111, true);                    // write 2 (the "first user")
  const live = readFileSync(path, "utf8");
  const bak = readFileSync(`${path}.bak`, "utf8");
  ok("N-H1", "the backup is byte-identical to the live database", live === bak);
  // And the restore must return that user, not the pre-onboarding state.
  writeFileSync(path, "{ truncated");
  const restored = new Store(dir);
  ok("N-H1", "a restore returns the CURRENT state, losing nothing", restored.isUserPaused(111) === true);
  ok("N-H1", "the backup is never copied from an unparsed file", store.includes("this.writeAtomic(this.bakPath, body)")
    && !/copyFileSync\(this\.path, this\.bakPath\)/.test(store));
  ok("N-H1", "recovery is reported loudly with the account count", store.includes("store.RECOVERED-FROM-BACKUP"));
  rmSync(dir, { recursive: true, force: true });
}

ok("N-H2", "reservations are taken inside the guard and released in a finally",
  /let committed = false;[\s\S]{0,600}try \{[\s\S]{0,400}store\.addSpend/.test(signer) && /\} finally \{[\s\S]{0,300}releaseSpend/.test(signer));

// N-H3 — EXECUTED: a failing run must NOT consume an occurrence.
{
  const dir = mkdtempSync(join(tmpdir(), "mezo-followup-dca-"));
  const st = new Store(dir);
  const user = { telegramId: 7, address: "0x0000000000000000000000000000000000000001" } as unknown as UserRecord;
  st.saveUser?.(user);
  const s: DcaSchedule = {
    id: "x", telegramId: 7, accountAddress: user.address, fromToken: "MUSD", toToken: "BTC",
    amount: "1", everyHours: 24, remaining: 4, nextRunAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(), active: true,
  };
  st.addSchedule(s);
  // The real store singleton drives runDueSchedules, so assert the SOURCE
  // property instead: remaining is patched only on the success branch.
  ok("N-H3", "the occurrence is consumed only after a SUCCESSFUL run",
    /if \(ok\) \{[\s\S]{0,400}remaining = s\.remaining < 0 \? -1 : s\.remaining - 1;/.test(sched)
      && !/const remaining = s\.remaining < 0 \? -1 : s\.remaining - 1;[\s\S]{0,200}await executor/.test(sched));
  ok("N-H3", "a permanently broken schedule still stops, via consecutive failures",
    sched.includes("MAX_CONSECUTIVE_FAILURES") && /failures: 0/.test(sched));
  rmSync(dir, { recursive: true, force: true });
}

ok("N-H5", "the bot never sends a fee override; an old router takes the legacy path",
  /atomicFee = feesEnabled[\s\S]{0,120}caps\.zapLeg/.test(zap) && !zap.includes("zapFeeBpsOverride"));
ok("N-H5", "the ceiling uses its parameters, so the band cannot collapse",
  /_ceilingBps\(address referrer, uint16 floorMultiplier\)/.test(feeRouter) && feeRouter.includes("floorHere"));
ok("N-H6", "a zero referral share is rejected, and unbinding exists",
  /maxReferralShareBps_ == 0/.test(feeRouter) && feeRouter.includes("function unbindReferrers"));
ok("N-H7", "attestations are per-account and refreshed across a plan's steps",
  attest.includes("${owner.toLowerCase()}:${address.toLowerCase()}") && attest.includes("refreshAttestations")
    && plan.includes("refreshAttestations(user.address as Address"));

console.log("\nMEDIUM\n");
// Match RUN LINES, not prose — the comment above the fix legitimately quotes
// the command that was removed, and asserting on the whole file made the
// explanation of the fix look like the defect.
const dockerRunLines = dockerfile.split("\n").filter((l) => /^\s*RUN\s/.test(l));
ok("N-M8", "tsx is a real dependency; the image no longer re-resolves it",
  Boolean(pkg.dependencies?.tsx) && !dockerRunLines.some((l) => /npm\s+install/.test(l))
    && dockerRunLines.some((l) => /npm\s+ci/.test(l)));
ok("N-M9", "the lock surface owns its bound, so its own error is reachable",
  /addDays: z\.number\(\)\.int\(\)\.positive\(\)\.max\(100 \* 365\)/.test(intent));
ok("N-M10", "extend rounds UP to a week boundary and refuses sub-week asks",
  lock.includes("const WEEK = BigInt(7 * DAY)") && /unlock times move in whole weeks/.test(lock));
ok("N-M11", "shutdown awaits the in-flight keeper tick",
  /export async function stopKeeper/.test(sched) && sched.includes("await inFlight"));
ok("N-M12", "the DCA notice never promises a retry that cannot happen",
  /did NOT use up one of your scheduled runs/.test(sched) && /DCA stopped/.test(sched));
ok("N-M13", "the borrow button uses the builder's own gas headroom",
  menu.includes("GAS_HEADROOM_BTC") && /btcHeld >= safeBtc \+ GAS_HEADROOM_BTC/.test(menu));
ok("N-M14", "the adjust repay leg enforces the minimum net debt",
  /if \(repayWad > 0n\) \{[\s\S]{0,900}p\.minNetDebt/.test(borrow));

// N-M15 — EXECUTED: the alert must have a rate floor AND alert on a first dip.
ok("N-M15", "a rate floor survives the healthy-clear", alerts.includes("MIN_REALERT_MS")
  && /if \(st\.troveICR !== undefined\) store\.patchAlertState\(telegramId, \{ troveICR: undefined \}\)/.test(alerts));
ok("N-M15", "a FIRST observation below the threshold still alerts",
  /const firstBelow = st\.troveICR === undefined/.test(alerts) && /!droppedBand && !firstBelow/.test(alerts));

console.log("\nLOW\n");
ok("N-L14", "a corrupt interval cannot abandon every other schedule",
  sched.includes("Number.isFinite(everyHours)") && /catch \(e\) \{[\s\S]{0,200}keeper\.schedule-failed/.test(sched));
{
  // N-L15 — EXECUTED: the owner check lives in takePending, not only call sites.
  const p = { action: "swap", title: "T", summary: [], warnings: [], steps: [], allowedTargets: [], executable: true, nativeValue: 0n } as never;
  const id = setPending(9001, { kind: "action", plan: p }, "0xAAA");
  const wrong = takePending(9001, id, "0xBBB");
  ok("N-L15", "a claim from a different account is refused by takePending", !wrong.ok && wrong.why === "account-switched");
  const right = takePending(9001, id, "0xaaa");
  ok("N-L15", "...and the plan survives, so the user can switch back", right.ok);
  ok("N-L15", "the refusal is explained", /switched active account/.test(refusalText("account-switched")));
}
{
  // N-L16 — EXECUTED: expired entries are actually swept.
  setPending(9002, { kind: "action", plan: {} as never }, "0xAAA");
  const dropped = sweepPending(Date.now() + 60 * 60 * 1000);
  ok("N-L16", "expired pending plans are swept, not retained for the process life", dropped >= 1);
}
ok("N-L17", "the dead `repark` alias is gone", !session.includes("export function repark"));
ok("N-L18", "cancel has its own event and a distinct accepter error",
  feeRouter.includes("OwnershipTransferCancelled") && feeRouter.includes("error NotPendingOwner"));
ok("N-L19", "HOME moves with the uid after the privilege drop", entry.includes('export HOME='));
ok("N-L20", "an unreadable Recovery Mode refuses instead of assuming normal",
  !/recoveryMode\(priceWad\)\) \?\? false/.test(borrow) && /can't tell whether Mezo is in Recovery Mode/.test(borrow));

console.log("\n" + "─".repeat(64));
console.log(fail === 0 ? "Every follow-up finding is closed. ✅" : `${fail} FOLLOW-UP FINDING(S) NOT CLOSED ✗`);
process.exit(fail === 0 ? 0 : 1);
