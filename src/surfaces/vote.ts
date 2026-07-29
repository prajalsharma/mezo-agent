import { encodeFunctionData, formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { voterAbi, votingEscrowAbi } from "../abis/mezo.js";
import { optimalAllocation, explainAllocation } from "../core/optimalVoting.js";
import { liveIncentives } from "../core/incentivesFeed.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan } from "./plan.js";
import type { VoteIntent } from "../llm/intent.js";

/**
 * Voting surface. In "optimal" mode we run the transparent water-filling
 * allocator (core/optimalVoting.ts) over live gauge incentives and show the user
 * the exact weights + expected reward BEFORE signing. In "manual" mode the
 * user's weights execute via Voter.vote(tokenId, pools, weights). Optimal mode
 * reads live epoch incentives + current vote weights on-chain
 * (core/incentivesFeed.ts) and submits the computed weights; zero posted
 * incentives is reported honestly as "nothing to optimize".
 */

export function buildVote(intent: VoteIntent): ActionPlan | Promise<ActionPlan> {
  if (intent.mode === "manual") {
    const weights = intent.weights ?? {};
    const entries = Object.entries(weights);
    if (entries.length === 0) throw new ActionUnavailableError("Manual vote needs at least one pool → weight.");
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total !== 10_000) throw new ActionUnavailableError(`Manual weights must sum to 10000 bps (got ${total}).`);
    const summary = ["Manual vote allocation:", ...entries.map(([p, w]) => `• ${p}: ${(w / 100).toFixed(1)}%`)];

    if (!registry.hasContract("Voter")) {
      return gatedPlan({ action: "vote", title: "🗳️ Vote (manual)", summary,
        reason: "Preview only — the Voter address isn't confirmed on this deployment yet. Votes persist across epochs once submitted." });
    }
    // On-chain submission needs the veBTC NFT that carries the voting power.
    // We never guess a token id — the user names it ("vote with veNFT 3").
    if (!intent.tokenId) {
      throw new ActionUnavailableError(
        'Which veBTC NFT should cast this vote? Say e.g. "vote with veNFT 3: 60% MUSD/mUSDC, 40% BTC/MUSD".',
      );
    }
    const pools: Address[] = [];
    const bps: bigint[] = [];
    for (const [poolName, w] of entries) {
      const p = registry.resolvePool(...(poolName.split("/") as [string, string]));
      if (!p) {
        const avail = registry.pools().map((x) => x.pair.join("/")).join(", ");
        throw new ActionUnavailableError(`Unknown pool "${poolName}". Available: ${avail}.`);
      }
      pools.push(p.address);
      bps.push(BigInt(w));
    }
    const voter = registry.contract("Voter");
    const step = {
      kind: "vote", to: voter, value: 0n,
      data: encodeFunctionData({
        abi: voterAbi, functionName: "vote",
        args: [BigInt(intent.tokenId), pools, bps],
      }),
      describe: `Vote veNFT #${intent.tokenId}: ${entries.map(([p, w]) => `${p} ${(w / 100).toFixed(0)}%`).join(", ")}`,
    };
    return {
      action: "vote", title: "🗳️ Vote (manual)", summary,
      warnings: ["Votes persist across epochs until changed; weights are relative."],
      steps: [step], allowedTargets: [voter], executable: true, nativeValue: 0n,
    };
  }

  // Optimal mode — async: reads live epoch incentives + current vote weights
  // straight from the chain (core/incentivesFeed.ts). We never fabricate
  // incentive numbers; zero posted incentives is reported as exactly that.
  return buildOptimalVote(intent);
}

/** Minimum total priced incentive (MUSD) before an optimal vote is executable. */
const MIN_INCENTIVE_MUSD = 1;

async function buildOptimalVote(intent: VoteIntent): Promise<ActionPlan> {
  if (!registry.hasContract("Voter")) {
    return gatedPlan({
      action: "vote", title: "🗳️ Vote (optimal)",
      summary: ["The optimizer allocates your veBTC to maximize expected fees + bribes per vote this epoch."],
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet.",
    });
  }

  // Require the veNFT id BEFORE the (expensive) feed read, and read the REAL
  // voting power from it — water-filling is not scale-free, so solving at V=1
  // over-concentrated every real position (Audit R2 H4).
  if (!intent.tokenId) {
    throw new ActionUnavailableError(
      'Which veBTC NFT should cast this vote? Say e.g. "vote optimally with veNFT 3".',
    );
  }
  const tokenId = BigInt(intent.tokenId);
  const votingPowerWei = (await publicClient().readContract({
    address: registry.contract("VotingEscrowBTC"),
    abi: votingEscrowAbi, functionName: "balanceOfNFT", args: [tokenId],
  })) as bigint;
  if (votingPowerWei <= 0n) {
    throw new ActionUnavailableError(`veNFT #${intent.tokenId} has no voting power (expired or not yours). Check the id.`);
  }
  const votingPower = Number(formatUnits(votingPowerWei, 18));

  const snapshot = await liveIncentives(Date.now() / 1000, tokenId);
  const totalIncentives = snapshot.gauges.reduce((s, g) => s + g.incentives, 0);
  const anyUnpriced = snapshot.gauges.some((g) => g.unpricedTokens.length > 0);

  // Raw per-gauge MUSD numbers, always shown so the user can sanity-check the
  // allocation and reject an implausible one (defends against thin-pool price
  // skew steering the vote — Audit R2 H5/M3).
  const rawLines = snapshot.gauges
    .filter((g) => g.incentivesMusdWei > 0n || g.unpricedTokens.length > 0)
    .map((g) => `• ${g.pool}: ~${g.incentives.toFixed(2)} MUSD incentives, ${g.otherVotes.toFixed(2)} other votes` +
      (g.unpricedTokens.length ? ` (+${g.unpricedTokens.length} unpriced reward token(s))` : ""));

  // Refuse to auto-submit when data is incomplete or trivially small — direct to
  // a manual vote instead of committing power on a maybe-manipulated snapshot.
  if (totalIncentives < MIN_INCENTIVE_MUSD || anyUnpriced) {
    throw new ActionUnavailableError(
      [
        anyUnpriced
          ? "Some gauges pay rewards in tokens with no MUSD price route, so an 'optimal' split can't be computed honestly without under-counting them."
          : `Total posted incentives this epoch are below ${MIN_INCENTIVE_MUSD} MUSD, so there's nothing meaningful to optimize.`,
        "",
        "Live per-gauge incentives:",
        ...rawLines,
        "",
        'Vote manually with the numbers above, e.g. "vote with veNFT ' + intent.tokenId + ': 60% MUSD/mUSDC, 40% BTC/MUSD".',
      ].join("\n"),
    );
  }

  const result = optimalAllocation(snapshot.gauges, votingPower);
  const summary = [
    "Optimal allocation (water-filling over LIVE incentives, computed for your veNFT's actual power):",
    ...explainAllocation(result),
    `Blended: ~${result.rewardPerVote.toFixed(4)} MUSD per unit of voting power; total ~${result.totalExpectedReward.toFixed(2)} MUSD.`,
    "",
    "Live per-gauge data used:",
    ...rawLines,
  ];

  const voter = registry.contract("Voter");
  const pools: Address[] = [];
  const bps: bigint[] = [];
  for (const a of result.allocations) {
    const p = registry.resolvePool(...(a.pool.split("/") as [string, string]));
    if (!p) continue;
    pools.push(p.address);
    bps.push(BigInt(a.weightBps));
  }
  const step = {
    kind: "vote", to: voter, value: 0n,
    data: encodeFunctionData({
      abi: voterAbi, functionName: "vote",
      args: [tokenId, pools, bps],
    }),
    describe: `Vote veNFT #${intent.tokenId} optimally: ${result.allocations.map((a) => `${a.pool} ${(a.weightBps / 100).toFixed(0)}%`).join(", ")}`,
  };
  return {
    action: "vote", title: "🗳️ Vote (optimal)", summary,
    warnings: [
      "Votes persist across epochs until changed.",
      "Incentive values are a live snapshot and can move; the raw per-gauge numbers are shown above — reject if they look wrong.",
    ],
    steps: [step], allowedTargets: [voter], executable: true, nativeValue: 0n,
  };
}
