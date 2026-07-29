/**
 * Optimal voting allocator (ve(3,3)).
 *
 * A voter earns from a gauge in proportion to their share of the votes on it:
 *
 *     reward_i(x_i) = incentives_i * x_i / (otherVotes_i + x_i)
 *
 * where `incentives_i` = projected fees + bribes on gauge i for the upcoming
 * epoch and `otherVotes_i` = everyone else's projected votes on it. Total reward
 * is the sum; each term is concave and increasing in x_i, so maximizing the sum
 * subject to Σx_i = V (your voting power) is a classic water-filling problem.
 *
 * Marginal value of the next vote on gauge i:
 *     m_i(x_i) = incentives_i * otherVotes_i / (otherVotes_i + x_i)^2
 * At the optimum every funded gauge shares one marginal value λ:
 *     x_i(λ) = max(0, sqrt(incentives_i * otherVotes_i / λ) - otherVotes_i)
 * We binary-search λ so Σ x_i(λ) = V. Fully deterministic and transparent — the
 * output includes the per-gauge rationale so the user sees WHY, not just what.
 */

export type GaugeStat = {
  pool: string; // human id, e.g. "BTC/MUSD"
  /** Projected fees + bribes for the epoch, in a common unit (e.g. USD). */
  incentives: number;
  /** Projected votes from everyone else on this gauge (same unit as power). */
  otherVotes: number;
};

export type Allocation = {
  pool: string;
  weightBps: number; // integer basis points, Σ = 10000
  expectedReward: number; // in the incentives unit
  sharePct: number; // your projected share of that gauge
};

export type OptimalResult = {
  allocations: Allocation[];
  totalExpectedReward: number;
  /** Blended yield: expected reward per unit of voting power. */
  rewardPerVote: number;
};

/**
 * Votes to place on gauge i at marginal price λ.
 *
 * Audit R2 H6: the previous form floored otherVotes at 1e-9 INSIDE the sqrt
 * numerator, so an uncontested gauge (otherVotes == 0) — which is the *best*
 * gauge, since you capture 100% of its incentives — got sqrt(incentives·1e-9/λ)
 * ≈ 0 votes, exactly inverting the optimum. An uncontested gauge has unbounded
 * marginal value at x→0, so it should be filled FIRST. We model that by giving
 * it a tiny synthetic otherVotes floor for the sqrt, but the caller
 * (`optimalAllocation`) also front-loads uncontested gauges explicitly below.
 */
function alloc(g: GaugeStat, lambda: number): number {
  if (g.incentives <= 0 || lambda <= 0) return 0;
  // For a truly uncontested gauge the marginal value is incentives/x², so the
  // λ-optimal allocation is sqrt(incentives/λ). Using the real otherVotes (0)
  // in the standard formula gives sqrt(0) - 0 = 0, which is wrong; treat the
  // uncontested case with its own closed form.
  if (g.otherVotes <= 0) return Math.sqrt(g.incentives / lambda);
  const x = Math.sqrt((g.incentives * g.otherVotes) / lambda) - g.otherVotes;
  return Math.max(0, x);
}

export function optimalAllocation(gauges: GaugeStat[], votingPower: number): OptimalResult {
  const usable = gauges.filter((g) => g.incentives > 0);
  if (votingPower <= 0 || usable.length === 0) {
    return { allocations: [], totalExpectedReward: 0, rewardPerVote: 0 };
  }

  // Binary-search λ. Larger λ => smaller total allocation, so total(λ) is
  // monotonically decreasing; we bracket the λ that spends exactly votingPower.
  // hi must exceed the largest marginal value; for an uncontested gauge that is
  // incentives/ε² which is huge, so derive hi from the uncontested closed form
  // (incentives/x²) at a small x, plus the contested ratio bound.
  let lo = 1e-12;
  const contestedHi = Math.max(0, ...usable.filter((g) => g.otherVotes > 0).map((g) => g.incentives / g.otherVotes));
  const uncontestedHi = Math.max(0, ...usable.filter((g) => g.otherVotes <= 0).map((g) => g.incentives)) / 1e-12;
  let hi = Math.max(contestedHi, uncontestedHi) + 1;
  const total = (l: number) => usable.reduce((s, g) => s + alloc(g, l), 0);
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > votingPower) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;

  const raw = usable.map((g) => ({ g, x: alloc(g, lambda) }));
  const spent = raw.reduce((s, r) => s + r.x, 0) || 1;

  // Convert to integer bps that sum to exactly 10000 (largest-remainder method).
  const exact = raw.map((r) => ({ pool: r.g.pool, g: r.g, x: r.x, bpsFloat: (r.x / spent) * 10_000 }));
  const withFloor = exact.map((e) => ({ ...e, bps: Math.floor(e.bpsFloat) }));
  let remainder = 10_000 - withFloor.reduce((s, e) => s + e.bps, 0);
  withFloor
    .sort((a, z) => z.bpsFloat - a.bpsFloat - (Math.floor(z.bpsFloat) - Math.floor(a.bpsFloat)))
    .forEach((e) => { if (remainder > 0) { e.bps += 1; remainder--; } });

  const allocations: Allocation[] = withFloor
    .filter((e) => e.bps > 0)
    .map((e) => {
      const myVotes = (e.bps / 10_000) * votingPower;
      const share = myVotes / (e.g.otherVotes + myVotes);
      return {
        pool: e.pool,
        weightBps: e.bps,
        sharePct: share * 100,
        expectedReward: e.g.incentives * share,
      };
    })
    .sort((a, z) => z.weightBps - a.weightBps);

  const totalExpectedReward = allocations.reduce((s, a) => s + a.expectedReward, 0);
  return { allocations, totalExpectedReward, rewardPerVote: totalExpectedReward / votingPower };
}

/** One-line, human-readable rationale for the confirmation screen. */
export function explainAllocation(r: OptimalResult): string[] {
  if (r.allocations.length === 0) return ["No positive-incentive gauges to vote on this epoch."];
  return r.allocations.map(
    (a) => `${a.pool}: ${(a.weightBps / 100).toFixed(1)}% → ~${a.expectedReward.toFixed(2)} (your share ${a.sharePct.toFixed(1)}%)`,
  );
}
