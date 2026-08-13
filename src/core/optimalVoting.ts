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
  if (g.incentives <= 0 || lambda <= 0 || g.otherVotes <= 0) return 0;
  const x = Math.sqrt((g.incentives * g.otherVotes) / lambda) - g.otherVotes;
  return Math.max(0, x);
}

/**
 * The smallest share worth giving a gauge: one basis point. Below this the
 * largest-remainder rounding would drop it to zero anyway.
 */
const MIN_BPS = 1;

export function optimalAllocation(gauges: GaugeStat[], votingPower: number): OptimalResult {
  const usable = gauges.filter((g) => g.incentives > 0);
  if (votingPower <= 0 || usable.length === 0) {
    return { allocations: [], totalExpectedReward: 0, rewardPerVote: 0 };
  }

  // UNCONTESTED GAUGES ARE A SPECIAL CASE, and treating them as a limit of the
  // contested formula was wrong in both directions.
  //
  // With otherVotes == 0 your reward is incentives · x/(x+0) = incentives — a
  // CONSTANT for any x > 0. So the marginal value of the second vote onward is
  // exactly zero: the right move is to put the minimum there and spend the rest
  // where votes still buy share. The previous closed form sqrt(incentives/λ)
  // instead gave them a full water-filling allocation (~13% of the power in the
  // worst case), starving contested gauges where that power actually earns.
  //
  // It also made the bisection numerically unsafe: `hi` was derived as
  // incentives/1e-12, which is 1e12x the incentive figure and reaches Infinity
  // for a large one — and an Infinite bracket makes every midpoint Infinity, so
  // the search returns garbage rather than failing.
  const uncontested = usable.filter((g) => g.otherVotes <= 0);
  const contested = usable.filter((g) => g.otherVotes > 0);

  // Reserve the floor for uncontested gauges; water-fill the remainder.
  const reservedFraction = Math.min(0.5, (uncontested.length * MIN_BPS) / 10_000);
  const fillPower = votingPower * (1 - reservedFraction);

  let raw: Array<{ g: GaugeStat; x: number }>;
  if (contested.length === 0) {
    // Nothing to compete for: reward is constant per gauge, so spread evenly.
    raw = uncontested.map((g) => ({ g, x: votingPower / uncontested.length }));
  } else {
    // Binary-search λ over the CONTESTED gauges only. total(λ) decreases in λ,
    // and hi is now a plain ratio bound — finite by construction.
    let lo = 1e-12;
    let hi = Math.max(0, ...contested.map((g) => g.incentives / g.otherVotes)) + 1;
    const total = (l: number) => contested.reduce((s, g) => s + alloc(g, l), 0);
    for (let iter = 0; iter < 100; iter++) {
      const mid = (lo + hi) / 2;
      if (total(mid) > fillPower) lo = mid;
      else hi = mid;
    }
    const lambda = (lo + hi) / 2;
    raw = [
      ...uncontested.map((g) => ({ g, x: (votingPower * MIN_BPS) / 10_000 })),
      ...contested.map((g) => ({ g, x: alloc(g, lambda) })),
    ];
  }
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
