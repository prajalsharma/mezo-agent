import { formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { voterAbi, votingRewardAbi } from "../abis/mezo.js";
import { poolAbi } from "../abis/pool.js";
import { votingRewardsForPool } from "./veEnumeration.js";
import type { GaugeStat } from "./optimalVoting.js";
import { log, errMsg } from "./log.js";

/**
 * Live gauge-incentives feed for the optimal-vote allocator.
 *
 * Sources, all read fresh per request — never fabricated, never cached:
 *   • incentives_i — Σ tokenRewardsPerEpoch(token, currentEpochStart) across the
 *     gauge's bribe AND fee reward contracts, valued in MUSD.
 *   • otherVotes_i — Voter.weights(pool) MINUS the caller's own current votes on
 *     that pool, so a gauge the user already backs isn't counted as competition.
 *
 * Valuation (Audit R2 M3): to avoid the size-slippage bias and manipulability of
 * quoting the whole reward pile, we quote a UNIT amount through the DEEPEST
 * MUSD-paired pool and scale linearly. A reward token with no MUSD route can't
 * be valued honestly; it is recorded per-gauge in `unpricedTokens` and the gauge
 * is flagged, so the caller can refuse to build an executable vote over
 * incomplete data rather than silently valuing it at zero.
 */

const WEEK = 604_800n;

export type GaugeIncentive = GaugeStat & {
  /** Reward tokens on this gauge that could not be valued in MUSD. */
  unpricedTokens: Address[];
  /** Raw MUSD-equivalent incentive (for display on the confirmation). */
  incentivesMusdWei: bigint;
};

export type IncentivesSnapshot = {
  gauges: GaugeIncentive[];
  epochStart: bigint;
};

/** Deepest MUSD-paired pool for `token`, with its MUSD-side reserve. */
async function deepestMusdPool(token: Address): Promise<{ pool: Address; musdReserve: bigint } | undefined> {
  const c = publicClient();
  const musd = registry.token("MUSD").address.toLowerCase();
  let best: { pool: Address; musdReserve: bigint } | undefined;
  for (const p of registry.pools()) {
    const routes = p.pair.map((s) => registry.routingAddress(registry.token(s)).toLowerCase());
    if (!routes.includes(token.toLowerCase()) || !routes.includes(musd)) continue;
    try {
      const token0 = (await c.readContract({ address: p.address, abi: poolAbi, functionName: "token0" })) as Address;
      const reserves = (await c.readContract({ address: p.address, abi: poolAbi, functionName: "getReserves" })) as [bigint, bigint, bigint];
      const musdReserve = token0.toLowerCase() === musd ? reserves[0] : reserves[1];
      if (!best || musdReserve > best.musdReserve) best = { pool: p.address, musdReserve };
    } catch {
      continue; // a reverting pool must not abort the search (Audit R2 M3)
    }
  }
  return best;
}

/** Value `amount` of `token` in MUSD via a UNIT quote scaled linearly. */
async function valueInMusd(token: Address, amount: bigint, decimals: number): Promise<bigint | undefined> {
  if (amount === 0n) return 0n;
  const musd = registry.token("MUSD");
  if (token.toLowerCase() === musd.address.toLowerCase()) return amount;
  const deep = await deepestMusdPool(token);
  if (!deep) return undefined;
  const unit = 10n ** BigInt(decimals); // one whole token
  try {
    const unitOut = (await publicClient().readContract({
      address: deep.pool, abi: poolAbi, functionName: "getAmountOut", args: [unit, token],
    })) as bigint;
    if (unitOut <= 0n) return undefined;
    // value = amount * (unitOut / unit) — done in integer math.
    return (amount * unitOut) / unit;
  } catch {
    return undefined;
  }
}

/** The caller's current votes on a pool, to net out of otherVotes. */
async function ownVotes(voter: Address, tokenId: bigint | undefined, pool: Address): Promise<bigint> {
  if (tokenId === undefined) return 0n;
  try {
    return (await publicClient().readContract({
      address: voter,
      abi: [{ type: "function", name: "votes", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }, { name: "pool", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "votes", args: [tokenId, pool],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * How much of the voting universe the allocator can actually see.
 *
 * It iterates `registry.pools()` — a compiled-in list — while the Voter holds
 * the real gauge set. On mainnet that was 3 pools against 26 gauges, carrying
 * about a fifth of `totalWeight()`, and the output was still presented as
 * "optimal". A confidently-wrong allocation over 19% of the universe is worse
 * than declining to optimise, so the caller now has to know the number.
 *
 * Fails OPEN to `undefined` (unknown coverage) rather than to a flattering 100%.
 */
export type VoterCoverage = {
  /** Gauges the Voter knows about. */
  totalGauges: number;
  /** Of those, how many are in our registry. */
  visibleGauges: number;
  /** Share of totalWeight() our registry pools account for, 0..1. */
  weightShare: number;
  /** Voter.maxVotingNum() — the most pools one vote may name. */
  maxVotingNum: number;
};

export async function voterCoverage(): Promise<VoterCoverage | undefined> {
  const c = publicClient();
  const voter = registry.contract("Voter");
  try {
    const [count, totalWeight, maxVotingNum] = await Promise.all([
      c.readContract({ address: voter, abi: voterAbi, functionName: "length" }) as Promise<bigint>,
      c.readContract({ address: voter, abi: voterAbi, functionName: "totalWeight" }) as Promise<bigint>,
      c.readContract({ address: voter, abi: voterAbi, functionName: "maxVotingNum" }).catch(() => 30n) as Promise<bigint>,
    ]);
    const total = Number(count);
    if (total === 0) return undefined;

    const known = new Set(registry.pools().map((p) => p.address.toLowerCase()));
    let visible = 0;
    let visibleWeight = 0n;
    // Bounded: read every gauge address, then the weights of the ones we know.
    const addresses = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        c.readContract({ address: voter, abi: voterAbi, functionName: "pools", args: [BigInt(i)] }).catch(() => undefined) as Promise<Address | undefined>,
      ),
    );
    for (const a of addresses) {
      if (!a || !known.has(a.toLowerCase())) continue;
      visible++;
      const w = (await c.readContract({ address: voter, abi: voterAbi, functionName: "weights", args: [a] }).catch(() => 0n)) as bigint;
      visibleWeight += w;
    }
    const weightShare = totalWeight > 0n ? Number((visibleWeight * 10_000n) / totalWeight) / 10_000 : 0;
    return { totalGauges: total, visibleGauges: visible, weightShare, maxVotingNum: Number(maxVotingNum) };
  } catch (e) {
    log.warn("incentives.coverage-unreadable", { error: errMsg(e) });
    return undefined;
  }
}

export async function liveIncentives(nowSeconds: number, tokenId?: bigint): Promise<IncentivesSnapshot> {
  const c = publicClient();
  const voter = registry.contract("Voter");
  const epochStart = (BigInt(Math.floor(nowSeconds)) / WEEK) * WEEK;
  const gauges: GaugeIncentive[] = [];

  for (const p of registry.pools()) {
    const weight = (await c.readContract({
      address: voter, abi: voterAbi, functionName: "weights", args: [p.address],
    })) as bigint;
    const mine = await ownVotes(voter, tokenId, p.address);
    const otherVotesWei = weight > mine ? weight - mine : 0n;

    const { bribe, fee } = await votingRewardsForPool(p.address);
    let incentivesMusdWei = 0n;
    const unpriced: Address[] = [];
    for (const rc of [bribe, fee]) {
      if (!rc) continue;
      for (const t of rc.tokens) {
        const amount = (await c.readContract({
          address: rc.contract, abi: votingRewardAbi, functionName: "tokenRewardsPerEpoch",
          args: [t, epochStart],
        }).catch(() => 0n)) as bigint;
        if (amount === 0n) continue;
        const dec = await tokenDecimals(t);
        // Unknown decimals means we cannot size the reward at all — record it as
        // unpriced rather than guessing 18 and being off by orders of magnitude.
        if (dec === undefined) { unpriced.push(t); continue; }
        const musd = await valueInMusd(t, amount, dec);
        if (musd === undefined) unpriced.push(t);
        else incentivesMusdWei += musd;
      }
    }

    gauges.push({
      pool: p.pair.join("/"),
      incentives: Number(formatUnits(incentivesMusdWei, 18)),
      otherVotes: Number(formatUnits(otherVotesWei, 18)),
      unpricedTokens: unpriced,
      incentivesMusdWei,
    });
  }

  return { gauges, epochStart };
}

/**
 * Decimals for a reward token: the registry first, then the token itself.
 *
 * Defaulting an unknown token to 18 was worse than not valuing it. An 8-decimal
 * reward would be read as 1e10 times its real size, and — because the token WAS
 * "priced", just wrongly — it sailed past the `anyUnpriced` guard that exists to
 * stop exactly this. A confidently wrong valuation steers the vote; an admitted
 * unknown one blocks it. Returns undefined when the decimals can't be
 * established, and the caller treats that as unpriced.
 */
async function tokenDecimals(addr: Address): Promise<number | undefined> {
  for (const t of registry.allTokens()) {
    if (registry.routingAddress(t).toLowerCase() === addr.toLowerCase()) return t.decimals;
  }
  try {
    const d = (await publicClient().readContract({
      address: addr,
      abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return undefined;
  }
}
