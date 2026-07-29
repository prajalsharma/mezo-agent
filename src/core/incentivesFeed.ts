import { formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { voterAbi, votingRewardAbi } from "../abis/mezo.js";
import { poolAbi } from "../abis/pool.js";
import { votingRewardsForPool } from "./veEnumeration.js";
import type { GaugeStat } from "./optimalVoting.js";

/**
 * Live gauge-incentives feed for the optimal-vote allocator.
 *
 * Sources, all read fresh per request — never fabricated, never cached:
 *   • incentives_i — Σ tokenRewardsPerEpoch(token, currentEpochStart) across the
 *     gauge's bribe AND fee reward contracts, valued in MUSD.
 *   • otherVotes_i — Voter.weights(pool), the votes already cast this epoch.
 *
 * Valuation is done through the DEX pools themselves (getAmountOut into MUSD),
 * so no external price oracle is introduced. A reward token with no MUSD route
 * cannot be priced honestly; it is EXCLUDED from the optimization and named in
 * `unpriced` so the user sees exactly what the optimizer ignored.
 */

const WEEK = 604_800n;

export type IncentivesSnapshot = {
  stats: GaugeStat[];
  /** Reward-token addresses that could not be valued in MUSD (excluded). */
  unpriced: Address[];
  epochStart: bigint;
};

/** Value `amount` of `token` in MUSD via a direct pool, or undefined. */
async function valueInMusd(token: Address, amount: bigint): Promise<bigint | undefined> {
  if (amount === 0n) return 0n;
  const musd = registry.token("MUSD");
  if (token.toLowerCase() === musd.address.toLowerCase()) return amount;
  const c = publicClient();
  for (const p of registry.pools()) {
    const [a, b] = p.pair.map((s) => registry.routingAddress(registry.token(s)).toLowerCase());
    const involvesToken = a === token.toLowerCase() || b === token.toLowerCase();
    const involvesMusd = a === musd.address.toLowerCase() || b === musd.address.toLowerCase();
    if (!involvesToken || !involvesMusd) continue;
    try {
      return (await c.readContract({
        address: p.address, abi: poolAbi, functionName: "getAmountOut", args: [amount, token],
      })) as bigint;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function liveIncentives(nowSeconds: number): Promise<IncentivesSnapshot> {
  const c = publicClient();
  const voter = registry.contract("Voter");
  const epochStart = (BigInt(Math.floor(nowSeconds)) / WEEK) * WEEK;
  const stats: GaugeStat[] = [];
  const unpriced = new Set<Address>();

  for (const p of registry.pools()) {
    const weight = (await c.readContract({
      address: voter, abi: voterAbi, functionName: "weights", args: [p.address],
    })) as bigint;

    const { bribe, fee } = await votingRewardsForPool(p.address);
    let incentivesMusd = 0n;
    for (const rc of [bribe, fee]) {
      if (!rc) continue;
      for (const t of rc.tokens) {
        const amount = (await c.readContract({
          address: rc.contract, abi: votingRewardAbi, functionName: "tokenRewardsPerEpoch",
          args: [t, epochStart],
        }).catch(() => 0n)) as bigint;
        if (amount === 0n) continue;
        const musd = await valueInMusd(t, amount);
        if (musd === undefined) unpriced.add(t);
        else incentivesMusd += musd;
      }
    }

    stats.push({
      pool: p.pair.join("/"),
      incentives: Number(formatUnits(incentivesMusd, 18)),
      otherVotes: Number(formatUnits(weight, 18)),
    });
  }

  return { stats, unpriced: [...unpriced], epochStart };
}
