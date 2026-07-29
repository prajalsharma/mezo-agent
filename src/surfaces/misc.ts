import { encodeFunctionData, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi, boostVoterAbi } from "../abis/mezo.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan, type ActionStep } from "./plan.js";
import type { MarketBuyIntent, MatchboxIntent, VeTransferIntent, VeMergeIntent } from "../llm/intent.js";

/**
 * Market, Matchbox and veNFT ops. Market/Matchbox ABIs are best-effort pending
 * Mezo's published interfaces, so those stay gated. veNFT transfer/merge use the
 * standard VotingEscrow interface and execute once its address is confirmed.
 */

export function buildMarketBrowse(query?: string): ActionPlan {
  return gatedPlan({
    action: "marketBrowse", title: "🛍️ Mezo Market",
    summary: [query ? `Browsing Market for “${query}”.` : "Browsing Mezo Market listings.",
      "Listings are read from the Market contract / indexer."],
    reason: "Preview only — the Market address/indexer isn't confirmed on this deployment yet.",
  });
}

export function buildMarketBuy(intent: MarketBuyIntent): ActionPlan {
  return gatedPlan({
    action: "marketBuy", title: "🛒 Buy from Market",
    summary: [`Purchase listing ${intent.listingId}.`, "Price + item details are shown from the Market contract before you confirm."],
    reason: "Preview only — the Market address isn't published in the canonical reference yet.",
  });
}

export function buildMatchbox(intent: MatchboxIntent): ActionPlan {
  if (!registry.hasContract("Matchbox")) {
    return gatedPlan({
      action: "matchbox", title: "🧩 Matchbox (boost)",
      summary: ["Direct your veMEZO boost onto veBTC gauges."],
      reason: "Preview only — the BoostVoter address isn't confirmed on this deployment yet.",
    });
  }
  const boostVoter = registry.contract("Matchbox");

  // Unpair = clear the veMEZO's boost votes. Fully specified: reset(veMezoId).
  if (intent.op === "unpair") {
    if (intent.veMezoId === undefined) {
      throw new ActionUnavailableError('Which veMEZO NFT should I clear? Say e.g. "unpair veMEZO 5".');
    }
    const step: ActionStep = {
      kind: "matchboxReset", to: boostVoter, value: 0n,
      data: encodeFunctionData({ abi: boostVoterAbi, functionName: "reset", args: [BigInt(intent.veMezoId)] }),
      describe: `Clear veMEZO #${intent.veMezoId} boost votes`,
    };
    return {
      action: "matchbox", title: "🧩 Matchbox — unpair", warnings: [],
      summary: [`Clear all boost votes from veMEZO #${intent.veMezoId}.`],
      steps: [step], allowedTargets: [boostVoter], executable: true, nativeValue: 0n,
    };
  }

  // Pair/boost = veMEZO votes on pool boost-gauges via BoostVoter.vote. Requires
  // the boosting veMEZO id and explicit pool weights (bps summing to 10000) — we
  // never guess which gauge to boost. Gauge addresses are the registry pools;
  // simulation before signing catches any boost-gauge resolution mismatch.
  if (intent.veMezoId === undefined) {
    throw new ActionUnavailableError(
      'Boosting needs your veMEZO NFT and where to point it, e.g. "pair veMEZO 5: 100% BTC/MUSD".',
    );
  }
  const weights = intent.weights ?? {};
  const entries = Object.entries(weights);
  if (entries.length === 0) {
    throw new ActionUnavailableError('Say which pool(s) to boost, e.g. "pair veMEZO 5: 60% BTC/MUSD, 40% MUSD/mUSDC".');
  }
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total !== 10_000) throw new ActionUnavailableError(`Boost weights must sum to 10000 bps (got ${total}).`);
  const gauges: Address[] = [];
  const bps: bigint[] = [];
  for (const [poolName, w] of entries) {
    const p = registry.resolvePool(...(poolName.split("/") as [string, string]));
    if (!p) throw new ActionUnavailableError(`Unknown pool "${poolName}". Available: ${registry.pools().map((x) => x.pair.join("/")).join(", ")}.`);
    gauges.push(p.address);
    bps.push(BigInt(w));
  }
  const step: ActionStep = {
    kind: "matchboxVote", to: boostVoter, value: 0n,
    data: encodeFunctionData({ abi: boostVoterAbi, functionName: "vote", args: [BigInt(intent.veMezoId), gauges, bps] }),
    describe: `Boost with veMEZO #${intent.veMezoId}: ${entries.map(([p, w]) => `${p} ${(w / 100).toFixed(0)}%`).join(", ")}`,
  };
  return {
    action: "matchbox", title: "🧩 Matchbox — boost", warnings: ["Boost votes persist across epochs until changed or reset."],
    summary: [
      `Point veMEZO #${intent.veMezoId} boost at: ${entries.map(([p, w]) => `${p} ${(w / 100).toFixed(0)}%`).join(", ")}.`,
      "Boosting raises a veBTC voter's fees + bribes per vote (up to 5×).",
    ],
    steps: [step], allowedTargets: [boostVoter], executable: true, nativeValue: 0n,
  };
}

export function buildVeTransfer(intent: VeTransferIntent, owner: `0x${string}`): ActionPlan {
  if (!/^0x[0-9a-fA-F]{40}$/.test(intent.to)) throw new ActionUnavailableError("Recipient must be a valid 0x address.");
  const summary = [`Transfer veNFT #${intent.tokenId} to ${intent.to}.`, "The lock and its voting power move to the recipient."];

  // veBTC and veMEZO share the VotingEscrow interface; we don't know which
  // collection this id belongs to without the addresses, so gate on both.
  if (!registry.hasContract("VotingEscrowBTC") && !registry.hasContract("VotingEscrowMEZO")) {
    return gatedPlan({ action: "veTransfer", title: "📤 Transfer veNFT", summary,
      reason: "Preview only — the VotingEscrow address isn't confirmed on this deployment yet." });
  }
  const ve = registry.hasContract("VotingEscrowBTC") ? registry.contract("VotingEscrowBTC") : registry.contract("VotingEscrowMEZO");
  const step: ActionStep = {
    kind: "transfer", to: ve, value: 0n,
    data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "transferFrom", args: [owner, intent.to as `0x${string}`, BigInt(intent.tokenId)] }),
    describe: `Transfer veNFT #${intent.tokenId} → ${intent.to}`,
  };
  return { action: "veTransfer", title: "📤 Transfer veNFT", summary, warnings: [], steps: [step], allowedTargets: [ve], executable: true, nativeValue: 0n };
}

export function buildVeMerge(intent: VeMergeIntent): ActionPlan {
  if (intent.fromTokenId === intent.toTokenId) throw new ActionUnavailableError("Pick two different veNFT ids to merge.");
  const summary = [`Merge veNFT #${intent.fromTokenId} into #${intent.toTokenId}.`,
    "The two locks combine; the longer unlock time applies to the merged position."];
  if (!registry.hasContract("VotingEscrowBTC") && !registry.hasContract("VotingEscrowMEZO")) {
    return gatedPlan({ action: "veMerge", title: "🔗 Merge veNFTs", summary,
      reason: "Preview only — the VotingEscrow address isn't confirmed on this deployment yet." });
  }
  const ve = registry.hasContract("VotingEscrowBTC") ? registry.contract("VotingEscrowBTC") : registry.contract("VotingEscrowMEZO");
  const step: ActionStep = {
    kind: "merge", to: ve, value: 0n,
    data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "merge", args: [BigInt(intent.fromTokenId), BigInt(intent.toTokenId)] }),
    describe: `Merge #${intent.fromTokenId} → #${intent.toTokenId}`,
  };
  return { action: "veMerge", title: "🔗 Merge veNFTs", summary, warnings: [], steps: [step], allowedTargets: [ve], executable: true, nativeValue: 0n };
}
