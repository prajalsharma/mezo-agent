export {};
/**
 * Run every check in one command, so a red harness is noticed the day it turns
 * red.
 *
 * Two assertions in `auditfixes` sat failing across two whole review rounds
 * without anyone catching them, for the dull reason that no single command ran
 * everything — each suite had to be remembered individually. A verification
 * story that rests on check scripts needs one door.
 *
 * REQUIRED suites must pass; the run exits non-zero if any of them fails.
 * ADVISORY ones report coverage rather than correctness (they exit non-zero by
 * design when something is merely untested), so they are shown but do not gate.
 *
 *   npm run checkall
 */
import { spawnSync } from "node:child_process";
import { rmSync, readdirSync } from "node:fs";

type Suite = { name: string; why: string; advisory?: boolean; needsArg?: boolean };

const SUITES: Suite[] = [
  // Custody and policy — the layers that hold user funds.
  { name: "policycheck", why: "spending caps bind, including BTC via the precompile" },
  { name: "capcheck", why: "every per-token cap is a bound that can actually bind" },
  { name: "exportcheck", why: "/export needs a fresh single-use token" },
  { name: "storecheck", why: "a torn write cannot destroy custody" },
  { name: "accesscheck", why: "unlisted users reach nothing" },
  // Correctness against the protocol and the user's intent.
  { name: "conformance", why: "the agent agrees with the deployed musd contracts" },
  { name: "confirmcheck", why: "the approved plan is the signed plan; automation is bounded" },
  { name: "parsecheck", why: "77 natural-language commands parse deterministically" },
  { name: "auditfixes", why: "round-2 audit fixes have not regressed" },
  { name: "referralcheck", why: "referral binding and payout agree with the chain" },
  { name: "feeverify", why: "fees are charged where and only where documented" },
  { name: "simcheck", why: "every surface's calldata simulates as expected" },
  // Regression harnesses for the three review rounds.
  { name: "reviewcheck", why: "every finding from the first review stays closed" },
  { name: "followupcheck", why: "every finding from the second review stays closed" },
  // Product surface.
  { name: "menucheck", why: "menu callbacks reach real handlers" },
  { name: "productcopy", why: "no user-facing string assumes testnet" },
  { name: "routercompat", why: "the calldata the bot emits exists on the deployed router" },
  { name: "phasecheck", why: "phase 2-5 surfaces build" },
  // Advisory: reports what is NOT covered, so a non-zero exit is information.
  { name: "deadendcheck", why: "actions with no button or tip pointing at them", advisory: true },
  // Needs a wallet address, so it cannot run unattended.
  { name: "flowcheck", why: "simulates every scored flow against a real wallet", needsArg: true },
];

// Each suite writes its own data dir; clear them so a stale one can't mask a bug.
for (const d of readdirSync(".").filter((f) => f.startsWith("data-"))) {
  rmSync(d, { recursive: true, force: true });
}

const failed: string[] = [];
const advisory: string[] = [];
const skipped: string[] = [];

for (const s of SUITES) {
  if (s.needsArg) {
    skipped.push(`${s.name} — needs a wallet address; run it directly`);
    console.log(`  ⊘ ${s.name.padEnd(15)} skipped (needs an argument)`);
    continue;
  }
  const r = spawnSync("npm", ["run", "--silent", s.name], { encoding: "utf8", shell: false });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const passed = r.status === 0;
  if (passed) {
    console.log(`  ✓ ${s.name.padEnd(15)} ${s.why}`);
  } else if (s.advisory) {
    advisory.push(s.name);
    console.log(`  • ${s.name.padEnd(15)} ${s.why} (advisory)`);
  } else {
    failed.push(s.name);
    console.log(`  ✗ ${s.name.padEnd(15)} FAILED — ${s.why}`);
    // Show only the failing lines, so one broken suite does not bury the rest.
    for (const line of out.split("\n").filter((l) => /✗|FAIL|Error/.test(l)).slice(0, 8)) {
      console.log(`      ${line.trim()}`);
    }
  }
}

console.log("\n" + "─".repeat(70));
console.log(`required passed : ${SUITES.filter((s) => !s.advisory && !s.needsArg).length - failed.length}/${SUITES.filter((s) => !s.advisory && !s.needsArg).length}`);
if (advisory.length) console.log(`advisory        : ${advisory.join(", ")} (coverage reports, not gates)`);
if (skipped.length) for (const s of skipped) console.log(`skipped         : ${s}`);
if (failed.length) console.log(`\nFAILED          : ${failed.join(", ")}`);

console.log(
  failed.length === 0
    ? "\nAll required checks pass. Run `npm run typecheck` and `npm run contracts:test` too. ✅"
    : `\n${failed.length} REQUIRED CHECK(S) FAILING ✗`,
);
process.exit(failed.length === 0 ? 0 : 1);
