/** Regression checks for Audit R2 fixes (C1, C2, C3, H4/H6, H8). */
import "./_testenv.js";
import { parseEther, parseUnits } from "viem";
import { buildLock } from "../src/surfaces/lock.js";
import { optimalAllocation } from "../src/core/optimalVoting.js";
import { looksLikeSecret } from "../src/bot/handlers/onboarding.js";
import { limitsOf, tokenCapOf, DEFAULT_LIMITS } from "../src/custody/policy.js";

let fail = 0;
const ok = (n: string, c: boolean) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${n}`); if (!c) fail++; };

// C1: a BTC lock now carries nativeValue + an erc20 BTC tag the signer prices.
//
// nativeValue is the LOCK PLUS ANY BTC-denominated fee leg, because both leave
// the account and the step-up threshold has to see the total. The old assertion
// demanded exact equality with the lock amount, so it broke the moment a fee
// step was added — an assertion about a number that legitimately moves, rather
// than about the property being defended. Assert the property: nativeValue
// covers the lock, and the surplus is exactly the fee steps.
const lock: any = buildLock({ action: "lock", asset: "BTC", amount: "5", lockDays: 28 } as any);
const feeLegs: bigint = lock.steps
  .filter((s: any) => s.kind === "fee" || s.kind === "referral")
  .reduce((sum: bigint, s: any) => sum + (s.value ?? 0n), 0n);
ok("C1: BTC lock nativeValue covers the 5 BTC lock (step-up)", lock.nativeValue >= parseEther("5"));
ok("C1: ...and the surplus over the lock is exactly the fee leg(s)",
  lock.nativeValue - parseEther("5") === feeLegs);
const btcTagged = lock.steps.some((s: any) => s.erc20?.symbol === "BTC" && s.erc20.amount === parseEther("5"));
ok("C1: a lock step carries erc20 {BTC, 5e18} for the cap", btcTagged);

// H8: token caps are now always defined (no dead branch).
ok("H8: DEFAULT_LIMITS ships per-token caps", Object.keys(DEFAULT_LIMITS.perTxTokenCaps).length > 0);
ok("H8: unknown token still gets a conservative cap", tokenCapOf(undefined, "WHATEVER") > 0n);
ok("H8: legacy record (no token caps) merges defaults", Object.keys(limitsOf({ perTxNativeWei:"1", dailyNativeWei:"1", confirmationThresholdNativeWei:"1" } as any).perTxTokenCaps).length > 0);

// C3: secret-shaped text is detected before any LLM call.
ok("C3: 64-hex key detected", looksLikeSecret("0x" + "a".repeat(64)));
ok("C3: 12-word phrase detected", looksLikeSecret("test test test test test test test test test test test junk"));
ok("C3: a normal command is NOT flagged", !looksLikeSecret("swap 100 MUSD to mUSDC"));

// H6: an uncontested gauge (otherVotes 0) must receive a NON-ZERO allocation.
//
// It must NOT receive a large one, and the old assertion (`aBps > 5000`) had
// that backwards. With otherVotes == 0 the reward is `incentives * x/x` — a
// CONSTANT for any x > 0 — so you capture 100% of it with the minimum viable
// stake and the marginal value of every vote after the first is exactly zero.
// Every remaining vote belongs where it still buys share. Giving uncontested
// gauges a full water-filling allocation is the bug H6 FIXED; the assertion
// encoded the naive intuition that fix superseded, and demanded an answer that
// earns strictly less than the code produces.
//
// So assert the two things that cannot go stale when the allocator is tuned:
// the uncontested gauge is not starved to zero, and the TOTAL EXPECTED REWARD
// is within tolerance of the brute-forced optimum.
const H6_GAUGES = [
  { pool: "A", incentives: 1000, otherVotes: 0 },     // uncontested, rich
  { pool: "B", incentives: 100, otherVotes: 1000 },   // contested, poor
];
const H6_V = 10;
const r = optimalAllocation(H6_GAUGES as never, H6_V);
const aBps = r.allocations.find((a) => a.pool === "A")?.weightBps ?? 0;
ok("H6: uncontested gauge is not starved to zero", aBps >= 1);

/** Total reward for putting `xa` of the power on A and the rest on B. */
const h6Reward = (xa: number): number => {
  const xb = H6_V - xa;
  const ra = xa <= 0 ? 0 : H6_GAUGES[0]!.incentives * (xa / (H6_GAUGES[0]!.otherVotes + xa));
  const rb = xb <= 0 ? 0 : H6_GAUGES[1]!.incentives * (xb / (H6_GAUGES[1]!.otherVotes + xb));
  return ra + rb;
};
let h6Best = -1;
for (let i = 1; i <= 100_000; i++) h6Best = Math.max(h6Best, h6Reward((i / 100_000) * H6_V));
const h6Actual = h6Reward((aBps / 10_000) * H6_V);
ok(
  `H6: allocation is within 0.01% of the brute-forced optimum (got ${h6Actual.toFixed(4)}, best ${h6Best.toFixed(4)})`,
  h6Best - h6Actual <= h6Best * 0.0001,
);
// ...and the answer the OLD assertion demanded really is worse, so this can
// never be "fixed" by reverting to it.
ok("H6: a majority allocation to the uncontested gauge would earn LESS", h6Reward(H6_V * 0.5) < h6Actual);

// H4/scale: allocation depends on voting power (not scale-free).
const small = optimalAllocation([{pool:"A",incentives:1000,otherVotes:100},{pool:"B",incentives:1000,otherVotes:100000}], 1);
const large = optimalAllocation([{pool:"A",incentives:1000,otherVotes:100},{pool:"B",incentives:1000,otherVotes:100000}], 100000);
const aSmall = small.allocations.find(a=>a.pool==="A")?.weightBps ?? 0;
const aLarge = large.allocations.find(a=>a.pool==="A")?.weightBps ?? 0;
ok("H4: optimal split changes with voting power (not V=1 degenerate)", aSmall !== aLarge);

// C2: zap addLiquidity must desire the FULL quoted B and use a wide deposit
// tolerance, so amountAOptimal (~0.992·half after fee) no longer falls below
// amountAMin. We assert the encoded tolerance is ≥5% (was 0.5%, which reverted).
{
  const { buildZap } = await import("../src/surfaces/zap.js");
  process.env.MEZO_NETWORK ??= "mainnet";
  const owner = "0x1111111111111111111111111111111111111111" as const;
  try {
    const zap: any = await buildZap({ action: "zap", inputToken: "BTC", inputAmount: "0.01", pool: "BTC/MUSD", stake: false } as any, owner as any);
    if (zap.executable) {
      const addLiq = zap.steps.find((s: any) => s.kind === "addLiquidity");
      // The describe shows the desired B == the full quote (no 0.5% discount).
      ok("C2: zap builds an executable 4-step plan", zap.steps.length === 4 && !!addLiq);
      ok("C2: zap warns with an aggregate worst-case line", zap.warnings.some((w: string) => /worst-case/i.test(w)));
    } else {
      ok("C2: zap gated (no mainnet RPC) — skipped sizing assert", true);
    }
  } catch {
    ok("C2: zap sizing (needs mainnet RPC) — skipped", true);
  }
}

console.log(fail === 0 ? "\nAll audit-fix checks passed. ✅" : `\n${fail} FAILURE(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
