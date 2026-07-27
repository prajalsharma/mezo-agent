import { registry } from "../registry/registry.js";
import { optimalAllocation, explainAllocation, type GaugeStat } from "../core/optimalVoting.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan } from "./plan.js";
import type { VoteIntent } from "../llm/intent.js";

/**
 * Voting surface. In "optimal" mode we run the transparent water-filling
 * allocator (core/optimalVoting.ts) over live gauge incentives and show the user
 * the exact weights + expected reward BEFORE signing. In "manual" mode we echo
 * the user's weights. Execution calls Voter.vote(tokenId, pools, weights) and is
 * gated until the Voter address + gauge incentive feed are confirmed.
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
    return gatedPlan({ action: "vote", title: "🗳️ Vote (manual)", summary,
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet. Votes persist across epochs once submitted." });
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
