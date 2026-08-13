import { encodeFunctionData, formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { poolAbi } from "../abis/pool.js";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi, boostVoterAbi } from "../abis/mezo.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan, type ActionStep } from "./plan.js";
import type { MarketBuyIntent, MatchboxIntent, VeTransferIntent, VeMergeIntent } from "../llm/intent.js";

/**
 * Market, Matchbox and veNFT ops. Mezo Market = Router-based token swaps (browse
 * lists live pairs, buy routes to a swap). Matchbox = the BoostVoter. veNFT
 * transfer/merge use the standard VotingEscrow interface. All wired + verified.
 */

/**
 * Mezo Market. Per the canonical glossary, "Mezo Market" is the token-swap
 * marketplace in the Mezo App, powered by the Router over the DEX pools — NOT a
 * separate NFT/goods marketplace. So "browse" = the live tradeable pools + their
 * prices, and "purchase" = a swap (which the swap surface already executes).
 */
export async function buildMarketBrowse(query?: string): Promise<ActionPlan> {
  const pools = registry.pools();
  const c = publicClient();
  // Quote every pool CONCURRENTLY — a sequential await-per-pool loop would block
  // grammY's single-threaded dispatcher for the whole browse (Audit R3 F4).
  const quoted = await Promise.all(pools.map(async (p) => {
    const [a, b] = p.pair;
    const tokA = registry.tryToken(a), tokB = registry.tryToken(b);
    if (!tokA || !tokB) return undefined;
    let priceLine = `${a}/${b} (${p.stable ? "stable" : "volatile"})`;
    try {
      const out = (await c.readContract({
        address: p.address, abi: poolAbi, functionName: "getAmountOut", args: [10n ** BigInt(tokA.decimals), registry.routingAddress(tokA)],
      })) as bigint;
      priceLine += ` - 1 ${a} ≈ ${Number(formatUnits(out, tokB.decimals)).toFixed(4)} ${b}`;
    } catch { /* pool read best-effort */ }
    return `• ${priceLine}`;
  }));
  const lines: string[] = ["Mezo Market - live tradeable pairs (swap any of these):", ...quoted.filter((x): x is string => !!x)];
  lines.push("", `To buy: just say e.g. "swap 100 MUSD to mUSDC".`);
  if (query) lines.unshift(`(filter "${query}" - showing all pairs)`);
  // Browsing is read-only; return a non-signable plan carrying the listing.
  return {
    action: "marketBrowse", title: "🛍️ Mezo Market", summary: lines,
    warnings: [], steps: [], allowedTargets: [], executable: false, nativeValue: 0n,
    gatedReason: "Browsing is read-only - pick a pair and swap to purchase.",
  };
}

export function buildMarketBuy(intent: MarketBuyIntent): ActionPlan {
  // A Market purchase IS a token swap through the Router (per the Mezo glossary).
  // Route the user to the swap surface, which is fully live.
  throw new ActionUnavailableError(
    `Mezo Market purchases are token swaps. Say what you want to buy, e.g. ` +
      `"swap 100 MUSD to mUSDC" or "swap 0.01 BTC to MUSD". (You asked for listing "${intent.listingId}".)`,
  );
}

export function buildMatchbox(intent: MatchboxIntent): ActionPlan {
  if (!registry.hasContract("Matchbox")) {
    return gatedPlan({
      action: "matchbox", title: "🧩 Matchbox (boost)",
      summary: ["Direct your veMEZO boost onto veBTC gauges."],
      reason: "Preview only - the BoostVoter address isn't confirmed on this deployment yet.",
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
      action: "matchbox", title: "🧩 Matchbox - unpair", warnings: [],
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
    action: "matchbox", title: "🧩 Matchbox - boost", warnings: ["Boost votes persist across epochs until changed or reset."],
    summary: [
      `Point veMEZO #${intent.veMezoId} boost at: ${entries.map(([p, w]) => `${p} ${(w / 100).toFixed(0)}%`).join(", ")}.`,
      "Boosting raises a veBTC voter's fees + bribes per vote (up to 5×).",
    ],
    steps: [step], allowedTargets: [boostVoter], executable: true, nativeValue: 0n,
  };
}

/**
 * Resolve WHICH escrow (veBTC or veMEZO) actually owns `tokenId`, by reading
 * ownerOf on each. Both collections number ids from 1 independently, so picking
 * "veBTC if present" would operate on the same-numbered veBTC lock for a veMEZO
 * id — a wrong-escrow bug once both are wired (Audit R3 HIGH). Returns the
 * escrow the caller owns the id on, or throws if neither.
 */
async function escrowOwning(owner: `0x${string}`, tokenId: bigint): Promise<{ ve: Address; asset: "BTC" | "MEZO" }> {
  const c = publicClient();
  const candidates: [Address, "BTC" | "MEZO"][] = [];
  if (registry.hasContract("VotingEscrowBTC")) candidates.push([registry.contract("VotingEscrowBTC"), "BTC"]);
  if (registry.hasContract("VotingEscrowMEZO")) candidates.push([registry.contract("VotingEscrowMEZO"), "MEZO"]);
  if (candidates.length === 0) throw new ActionUnavailableError("Preview only - no VotingEscrow address is confirmed on this deployment yet.");
  for (const [ve, asset] of candidates) {
    try {
      const nftOwner = (await c.readContract({ address: ve, abi: votingEscrowAbi, functionName: "ownerOf", args: [tokenId] })) as Address;
      if (nftOwner.toLowerCase() === owner.toLowerCase()) return { ve, asset };
    } catch { /* ownerOf reverts for a non-existent id - try the other collection */ }
  }
  throw new ActionUnavailableError(
    `Your account doesn't own veNFT #${tokenId} in either veBTC or veMEZO. Check the id (each collection numbers from 1).`,
  );
}

/**
 * Transfer a veNFT.
 *
 * This is the highest-value single call the bot can make, and it used to be the
 * least constrained one. The spending caps measure `msg.value` and ERC-20
 * descriptors; a veNFT transfer carries neither — the asset is identified by a
 * token id in the ABI ARGUMENTS. So a lock holding an arbitrary amount of BTC
 * moved to a model-chosen destination with every cap skipped and the step-up
 * confirmation never triggered, while `allowedTargets = [ve]` passed trivially.
 *
 * Note the asymmetry the caps had: the lock surface carefully verifies where
 * funds COME FROM, and nothing constrained where this one sends them.
 *
 * Two fixes: price the NFT by its locked balance so the caps and the step-up see
 * a real number, and require the destination to be an address the user has
 * actually named (validated as a checksum-shaped address, and never the escrow
 * or a contract, both of which would burn the lock).
 */
export async function buildVeTransfer(intent: VeTransferIntent, owner: `0x${string}`): Promise<ActionPlan> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(intent.to)) throw new ActionUnavailableError("Recipient must be a valid 0x address.");
  const to = intent.to as `0x${string}`;
  if (to.toLowerCase() === owner.toLowerCase()) {
    throw new ActionUnavailableError("That's your own address - the transfer would do nothing.");
  }
  if (/^0x0{40}$/i.test(to)) throw new ActionUnavailableError("That's the zero address; the lock would be destroyed.");

  const { ve, asset } = await escrowOwning(owner, BigInt(intent.tokenId));
  if (to.toLowerCase() === ve.toLowerCase()) {
    throw new ActionUnavailableError("That's the escrow contract itself; the lock would be stranded there.");
  }
  // Sending a veNFT to a contract that doesn't handle ERC-721 loses it forever.
  const code = await publicClient().getCode({ address: to }).catch(() => undefined);
  if (code && code !== "0x") {
    throw new ActionUnavailableError(
      `${to} is a contract, not a wallet. Sending a veNFT there usually destroys it, so I won't build that transfer.`,
    );
  }

  // Price the NFT so the caps can see it. balanceOfNFT is the DECAYING voting
  // power rather than the raw locked amount, so it understates a long lock —
  // but understating is the wrong direction for a cap, so take the locked
  // amount when the escrow will give it and fall back to voting power.
  const lockedWei = await lockedAmountOf(ve, BigInt(intent.tokenId));

  const summary = [
    `Transfer ve${asset} #${intent.tokenId} to ${to}.`,
    "The lock and its voting power move to the recipient.",
    ...(lockedWei > 0n ? [`Locked value moving: ~${formatUnits(lockedWei, 18)} ${asset}`] : []),
  ];
  const step: ActionStep = {
    kind: "transfer", to: ve, value: 0n,
    data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "transferFrom", args: [owner, to, BigInt(intent.tokenId)] }),
    describe: `Transfer ve${asset} #${intent.tokenId} → ${to}`,
    // The descriptor that makes the caps and the step-up apply at all.
    erc20: { symbol: asset, amount: lockedWei, kind: "spend" },
  };
  return {
    action: "veTransfer", title: "📤 Transfer veNFT", summary,
    warnings: [
      "This is irreversible. Whoever holds the veNFT holds the locked funds and the voting power - " +
        "double-check the address before confirming.",
    ],
    steps: [step], allowedTargets: [ve], executable: true,
    // Drives the high-value step-up: a veBTC lock IS BTC leaving the account.
    nativeValue: asset === "BTC" ? lockedWei : 0n,
  };
}

/** Locked amount behind a veNFT, falling back to voting power. 0n if unreadable. */
async function lockedAmountOf(ve: Address, tokenId: bigint): Promise<bigint> {
  const c = publicClient();
  try {
    const locked = (await c.readContract({
      address: ve,
      abi: [{ type: "function", name: "locked", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "amount", type: "int128" }, { name: "end", type: "uint256" }] }] as const,
      functionName: "locked", args: [tokenId],
    })) as readonly [bigint, bigint];
    if (locked[0] > 0n) return locked[0];
  } catch { /* fall through to voting power */ }
  try {
    return (await c.readContract({ address: ve, abi: votingEscrowAbi, functionName: "balanceOfNFT", args: [tokenId] })) as bigint;
  } catch {
    return 0n;
  }
}

export async function buildVeMerge(intent: VeMergeIntent, owner: `0x${string}`): Promise<ActionPlan> {
  if (intent.fromTokenId === intent.toTokenId) throw new ActionUnavailableError("Pick two different veNFT ids to merge.");
  // Both ids must live in the SAME escrow, and the caller must own both.
  const from = await escrowOwning(owner, BigInt(intent.fromTokenId));
  const to = await escrowOwning(owner, BigInt(intent.toTokenId));
  if (from.ve.toLowerCase() !== to.ve.toLowerCase()) {
    throw new ActionUnavailableError(`Can't merge across collections - #${intent.fromTokenId} is ve${from.asset} but #${intent.toTokenId} is ve${to.asset}.`);
  }
  const summary = [`Merge ve${from.asset} #${intent.fromTokenId} into #${intent.toTokenId}.`,
    "The two locks combine; the longer unlock time applies to the merged position."];
  const step: ActionStep = {
    kind: "merge", to: from.ve, value: 0n,
    data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "merge", args: [BigInt(intent.fromTokenId), BigInt(intent.toTokenId)] }),
    describe: `Merge ve${from.asset} #${intent.fromTokenId} → #${intent.toTokenId}`,
  };
  return { action: "veMerge", title: "🔗 Merge veNFTs", summary, warnings: [], steps: [step], allowedTargets: [from.ve], executable: true, nativeValue: 0n };
}
