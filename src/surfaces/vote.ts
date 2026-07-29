import { encodeFunctionData, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { voterAbi } from "../abis/mezo.js";
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

async function buildOptimalVote(intent: VoteIntent): Promise<ActionPlan> {
  if (!registry.hasContract("Voter")) {
    return gatedPlan({
      action: "vote", title: "🗳️ Vote (optimal)",
      summary: ["The optimizer allocates your veBTC to maximize expected fees + bribes per vote this epoch."],
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet.",
    });
  }

  const snapshot = await liveIncentives(Date.now() / 1000);
  const totalIncentives = snapshot.stats.reduce((s, g) => s + g.incentives, 0);

  if (totalIncentives <= 0) {
    // Honest live state — not a gate. There is nothing to optimize against.
    throw new ActionUnavailableError(
      "No bribes or fee rewards are posted on the pool gauges for this epoch (checked live just now), " +
        'so there is no incentive data to optimize. You can still vote manually: e.g. "vote with veNFT 3: 60% MUSD/mUSDC, 40% BTC/MUSD".',
    );
  }

  const result = optimalAllocation(snapshot.stats, 1);
  const summary = [
    "Optimal allocation (maximizes expected reward-per-vote this epoch, water-filling method):",
    ...explainAllocation(result),
    `Blended: ~${result.rewardPerVote.toFixed(4)} MUSD-equivalent per unit of voting power.`,
  ];
  if (snapshot.unpriced.length > 0) {
    summary.push(
      `⚠️ Excluded from optimization (no MUSD price route): ${snapshot.unpriced.map((a) => a.slice(0, 10) + "…").join(", ")}.`,
    );
  }

  if (!intent.tokenId) {
    // The allocation is shown, but we never guess which veNFT casts it.
    throw new ActionUnavailableError(
      summary.join("\n") + '\n\nWhich veBTC NFT should cast this vote? Say e.g. "vote optimally with veNFT 3".',
    );
  }

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
      args: [BigInt(intent.tokenId), pools, bps],
    }),
    describe: `Vote veNFT #${intent.tokenId} optimally: ${result.allocations.map((a) => `${a.pool} ${(a.weightBps / 100).toFixed(0)}%`).join(", ")}`,
  };
  return {
    action: "vote", title: "🗳️ Vote (optimal)", summary,
    warnings: ["Votes persist across epochs until changed; weights are relative."],
    steps: [step], allowedTargets: [voter], executable: true, nativeValue: 0n,
  };
}
