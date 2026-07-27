import { encodeFunctionData } from "viem";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi } from "../abis/mezo.js";
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
  const summary =
    intent.op === "pair"
      ? [`Pair veBTC #${intent.veBtcId}${intent.veMezoId !== undefined ? ` with veMEZO #${intent.veMezoId}` : ""} via Matchbox.`,
         "Pairing boosts the veBTC position's fees + bribes per unit of voting power (up to 5×)."]
      : [`Unpair veBTC #${intent.veBtcId} from its Matchbox match.`];
  return gatedPlan({
    action: "matchbox", title: "🧩 Matchbox pairing", summary,
    reason: "Preview only — the Matchbox contract address isn't published in the canonical reference yet.",
  });
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
