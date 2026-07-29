import { encodeFunctionData, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { voterAbi } from "../abis/mezo.js";
import { optimalAllocation, explainAllocation, type GaugeStat } from "../core/optimalVoting.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan } from "./plan.js";
import type { VoteIntent } from "../llm/intent.js";

/**
 * Voting surface. In "optimal" mode we run the transparent water-filling
 * allocator (core/optimalVoting.ts) over live gauge incentives and show the user
 * the exact weights + expected reward BEFORE signing. In "manual" mode the
 * user's weights execute via Voter.vote(tokenId, pools, weights). Optimal-mode
 * SUBMISSION stays gated until a live incentives feed exists — we never
 * fabricate the incentive numbers the optimizer needs.
 */

/**
 * Live gauge incentives (fees + bribes) + projected votes for the epoch. Sourced
 * from the indexer in production; empty until that + the Voter land, which is why
 * optimal-mode execution is gated (we never fabricate incentive numbers).
 */
export function gaugeStats(): GaugeStat[] {
  return []; // indexer-backed; wired alongside the Voter address.
}

export function buildVote(intent: VoteIntent): ActionPlan {
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

  // Optimal mode: run the allocator over live gauge incentives.
  const stats = gaugeStats();
  if (stats.length === 0) {
    return gatedPlan({
      action: "vote", title: "🗳️ Vote (optimal)",
      summary: [
        "The optimizer will allocate your veBTC to maximize expected fees + bribes per vote this epoch,",
        "using the transparent water-filling method (equalizing marginal reward-per-vote across gauges).",
      ],
      reason: "Preview only — live gauge incentives (indexer) + the Voter address aren't wired on this deployment yet.",
    });
  }

  // votingPower would be read from the user's veBTC balance; normalized to 1 here
  // for the preview weighting (weights are scale-invariant).
  const result = optimalAllocation(stats, 1);
  const summary = [
    "Optimal allocation (maximizes expected reward-per-vote this epoch):",
    ...explainAllocation(result),
    `Blended: ~${result.rewardPerVote.toFixed(3)} reward per unit of voting power.`,
  ];
  return gatedPlan({ action: "vote", title: "🗳️ Vote (optimal)", summary,
    reason: "Optimizer computed the weights; execution is gated until the Voter address is confirmed." });
}
