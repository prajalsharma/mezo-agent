import { encodeFunctionData, formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { voterAbi, votingEscrowAbi } from "../abis/mezo.js";
import { optimalAllocation, explainAllocation } from "../core/optimalVoting.js";
import { liveIncentives, voterCoverage } from "../core/incentivesFeed.js";
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

/**
 * Vote-mechanics preconditions the builder never used to read, so breaching any
 * of them reverted opaquely AFTER the user had signed.
 *
 * - `maxVotingNum` caps how many pools one vote may name (30 on both networks).
 * - `lastVoted` records the epoch a veNFT last voted in; re-voting inside the
 *   same epoch is rejected on-chain.
 * - `ownerOf` is the check `vote.ts` already CLAIMED to make ("expired or not
 *   yours") while `buildVote` received no owner at all and structurally could
 *   not perform it.
 */
async function assertVotable(tokenId: bigint, poolCount: number, owner?: Address): Promise<void> {
  const c = publicClient();
  const voter = registry.contract("Voter");

  if (owner && registry.hasContract("VotingEscrowBTC")) {
    try {
      const nftOwner = (await c.readContract({
        address: registry.contract("VotingEscrowBTC"),
        abi: votingEscrowAbi, functionName: "ownerOf", args: [tokenId],
      })) as Address;
      if (nftOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new ActionUnavailableError(
          `veNFT #${tokenId} belongs to ${nftOwner}, not to your account. You can only vote with a lock you own.`,
        );
      }
    } catch (err) {
      if (err instanceof ActionUnavailableError) throw err;
      // ownerOf reverts for a non-existent id — the power check below catches it.
    }
  }

  const maxVotingNum = Number(
    (await c.readContract({ address: voter, abi: voterAbi, functionName: "maxVotingNum" }).catch(() => 30n)) as bigint,
  );
  if (poolCount > maxVotingNum) {
    throw new ActionUnavailableError(
      `That vote names ${poolCount} pools, but Mezo allows at most ${maxVotingNum} in a single vote. Split it, or back fewer gauges.`,
    );
  }

  // Already voted this epoch? Velodrome-style Voters reject a second vote from
  // the same veNFT inside one epoch.
  try {
    const last = (await c.readContract({
      address: voter, abi: voterAbi, functionName: "lastVoted", args: [tokenId],
    })) as bigint;
    if (last > 0n) {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const epochStart = (nowSec / WEEK) * WEEK;
      if (last >= epochStart) {
        const flips = new Date(Number((epochStart + WEEK) * 1000n)).toUTCString();
        throw new ActionUnavailableError(
          `veNFT #${tokenId} already voted this epoch, and Mezo only allows one vote per epoch per lock. ` +
            `The next epoch begins ${flips} - your current vote stays in force until then.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof ActionUnavailableError) throw err;
    // Unreadable — fall through; simulation still runs before signing.
  }
}

const WEEK = 604_800n;

export async function buildVote(intent: VoteIntent, owner?: Address): Promise<ActionPlan> {
  if (intent.mode === "manual") {
    const weights = intent.weights ?? {};
    const entries = Object.entries(weights);
    if (entries.length === 0) throw new ActionUnavailableError("Manual vote needs at least one pool → weight.");
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total !== 10_000) throw new ActionUnavailableError(`Manual weights must sum to 10000 bps (got ${total}).`);
    const summary = ["Manual vote allocation:", ...entries.map(([p, w]) => `• ${p}: ${(w / 100).toFixed(1)}%`)];

    if (!registry.hasContract("Voter")) {
      return gatedPlan({ action: "vote", title: "🗳️ Vote (manual)", summary,
        reason: "Preview only - the Voter address isn't confirmed on this deployment yet. Votes persist across epochs once submitted." });
    }
    // On-chain submission needs the veBTC NFT that carries the voting power.
    // We never guess a token id — the user names it ("vote with veNFT 3").
    if (!intent.tokenId) {
      throw new ActionUnavailableError(
        'Which veBTC NFT should cast this vote? Say e.g. "vote with veNFT 3: 60% MUSD/mUSDC, 40% BTC/MUSD".',
      );
    }
    // Pre-check the veNFT actually carries voting power BEFORE building the tx —
    // same guard optimal mode already has, so a wrong/expired id gives a plain
    // message instead of a raw on-chain revert. (Fail-open if the escrow isn't
    // wired; the pre-Confirm simulation still backstops it.)
    if (registry.hasContract("VotingEscrowBTC")) {
      try {
        const power = (await publicClient().readContract({
          address: registry.contract("VotingEscrowBTC"),
          abi: votingEscrowAbi, functionName: "balanceOfNFT", args: [BigInt(intent.tokenId)],
        })) as bigint;
        if (power <= 0n) {
          throw new ActionUnavailableError(`veNFT #${intent.tokenId} has no voting power (expired or not yours). Check the id.`);
        }
      } catch (err) {
        if (err instanceof ActionUnavailableError) throw err; // real "no power" — surface it
        // otherwise a read hiccup — fail open, let simulation catch a bad id
      }
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
    await assertVotable(BigInt(intent.tokenId), pools.length, owner);
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
  return await buildOptimalVote(intent, owner);
}

/** Minimum total priced incentive (MUSD) before an optimal vote is executable. */
const MIN_INCENTIVE_MUSD = 1;

async function buildOptimalVote(intent: VoteIntent, owner?: Address): Promise<ActionPlan> {
  if (!registry.hasContract("Voter")) {
    return gatedPlan({
      action: "vote", title: "🗳️ Vote (optimal)",
      summary: ["The optimizer allocates your veBTC to maximize expected fees + bribes per vote this epoch."],
      reason: "Preview only - the Voter address isn't confirmed on this deployment yet.",
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

  // HOW MUCH OF THE UNIVERSE DID WE ACTUALLY SEE?
  //
  // The allocator solves over `registry.pools()` — a compiled-in list — while
  // the Voter holds the real gauge set. On mainnet that is 3 of 26 gauges,
  // about a fifth of total voting weight, and the result was still labelled
  // "optimal". The maths is sound; the input set is not, and a confident answer
  // over a fifth of the problem is worse than an honest partial one. So the
  // coverage is measured, stated on the card, and the word "optimal" is only
  // used when it is nearly true.
  const coverage = await voterCoverage();
  const wellCovered = coverage !== undefined && coverage.weightShare >= 0.9;
  const label = wellCovered ? "Optimal" : "Best available";
  const coverageLines: string[] = [];
  if (coverage) {
    coverageLines.push(
      "",
      `Coverage: ${coverage.visibleGauges} of ${coverage.totalGauges} gauges on this Voter ` +
        `(~${(coverage.weightShare * 100).toFixed(1)}% of all voting weight).`,
    );
    if (!wellCovered) {
      coverageLines.push(
        `This is the best split across the gauges I can see - NOT across every gauge. ` +
          `${(100 - coverage.weightShare * 100).toFixed(1)}% of the voting weight sits on gauges I don't track, ` +
          `and one of them may pay better. Vote manually if you want to back one of those.`,
      );
    }
  } else {
    coverageLines.push("", "I couldn't read the Voter's full gauge list, so I can't tell you how much of it this covers.");
  }

  const summary = [
    `${label} allocation (water-filling over LIVE incentives, computed for your veNFT's actual power):`,
    ...explainAllocation(result),
    `Blended: ~${result.rewardPerVote.toFixed(4)} MUSD per unit of voting power; total ~${result.totalExpectedReward.toFixed(2)} MUSD.`,
    ...coverageLines,
    "",
    "Live per-gauge data used:",
    ...rawLines,
  ];

  const voter = registry.contract("Voter");
  const pools: Address[] = [];
  const bps: bigint[] = [];
  for (const a of result.allocations) {
    const p = registry.resolvePool(...(a.pool.split("/") as [string, string]));
    // Silently skipping an unresolvable pool used to leave the weights summing
    // to less than 10000, and the Voter reallocates that remainder itself — so
    // the vote cast was not the vote shown. Refuse instead.
    if (!p) {
      throw new ActionUnavailableError(
        `The allocator picked "${a.pool}", which I can't resolve to a pool address, so the weights would no longer ` +
          `sum to 100% and the Voter would redistribute the remainder for you. Vote manually instead.`,
      );
    }
    pools.push(p.address);
    bps.push(BigInt(a.weightBps));
  }
  const totalBps = bps.reduce((s, w) => s + w, 0n);
  if (totalBps !== 10_000n) {
    throw new ActionUnavailableError(
      `Internal check failed: the computed weights sum to ${totalBps} bps, not 10000. Refusing to submit a vote I can't account for.`,
    );
  }
  await assertVotable(tokenId, pools.length, owner);
  const step = {
    kind: "vote", to: voter, value: 0n,
    data: encodeFunctionData({
      abi: voterAbi, functionName: "vote",
      args: [tokenId, pools, bps],
    }),
    describe: `Vote veNFT #${intent.tokenId}: ${result.allocations.map((a) => `${a.pool} ${(a.weightBps / 100).toFixed(0)}%`).join(", ")}`,
  };
  return {
    action: "vote", title: `🗳️ Vote (${wellCovered ? "optimal" : "best available"})`, summary,
    warnings: [
      "Votes persist across epochs until changed, and a lock can only vote once per epoch.",
      "Incentive values are a live snapshot and can move; the raw per-gauge numbers are shown above - reject if they look wrong.",
      ...(wellCovered ? [] : ["This is NOT a whole-market optimum - see the coverage line above."]),
    ],
    steps: [step], allowedTargets: [voter], executable: true, nativeValue: 0n,
  };
}
