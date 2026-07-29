import { type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi, voterAbi, votingRewardAbi, rewardsDistributorAbi } from "../abis/mezo.js";

/**
 * Live enumeration over the ve(3,3) system: which veNFTs an owner holds, what
 * rebase is claimable per NFT, and which bribe/fee reward contracts (and reward
 * tokens) exist per gauge. Everything here is read fresh from the chain per
 * request — no cached ids, no fabricated incentive numbers. Enumeration path
 * (balanceOf + ownerToNFTokenIdList) verified against the production escrow.
 */

const ZERO = "0x0000000000000000000000000000000000000000";

/** Safety bound: a user with more veNFTs than this claims via explicit ids. */
const MAX_ENUMERATED_NFTS = 50n;

export async function ownedVeNfts(owner: Address): Promise<bigint[]> {
  const ve = registry.contract("VotingEscrowBTC");
  const c = publicClient();
  const n = (await c.readContract({
    address: ve, abi: votingEscrowAbi, functionName: "balanceOf", args: [owner],
  })) as bigint;
  const count = n > MAX_ENUMERATED_NFTS ? MAX_ENUMERATED_NFTS : n;
  const ids: bigint[] = [];
  for (let i = 0n; i < count; i++) {
    const id = (await c.readContract({
      address: ve, abi: votingEscrowAbi, functionName: "ownerToNFTokenIdList", args: [owner, i],
    })) as bigint;
    if (id > 0n) ids.push(id);
  }
  return ids;
}

export async function claimableRebase(tokenId: bigint): Promise<bigint> {
  const c = publicClient();
  return (await c.readContract({
    address: registry.contract("RewardsDistributor"),
    abi: rewardsDistributorAbi,
    functionName: "claimable",
    args: [tokenId],
  })) as bigint;
}

export type VotingReward = {
  /** The bribe or fee contract attached to a gauge. */
  contract: Address;
  /** Reward tokens it distributes. */
  tokens: Address[];
};

/** Bribe + fee reward contracts (with token lists) for one pool's gauge. */
export async function votingRewardsForPool(poolAddr: Address): Promise<{ bribe?: VotingReward; fee?: VotingReward }> {
  const c = publicClient();
  const voter = registry.contract("Voter");
  const gauge = (await c.readContract({
    address: voter, abi: voterAbi, functionName: "gauges", args: [poolAddr],
  })) as Address;
  if (!gauge || gauge.toLowerCase() === ZERO) return {};

  const out: { bribe?: VotingReward; fee?: VotingReward } = {};
  for (const kind of ["gaugeToBribe", "gaugeToFees"] as const) {
    const rc = (await c.readContract({
      address: voter, abi: voterAbi, functionName: kind, args: [gauge],
    })) as Address;
    if (!rc || rc.toLowerCase() === ZERO) continue;
    const len = (await c.readContract({
      address: rc, abi: votingRewardAbi, functionName: "rewardsListLength", args: [],
    })) as bigint;
    const tokens: Address[] = [];
    for (let i = 0n; i < len; i++) {
      tokens.push((await c.readContract({
        address: rc, abi: votingRewardAbi, functionName: "rewards", args: [i],
      })) as Address);
    }
    if (kind === "gaugeToBribe") out.bribe = { contract: rc, tokens };
    else out.fee = { contract: rc, tokens };
  }
  return out;
}

/** Total earned across a reward contract's tokens for one veNFT (display). */
export async function earnedAcross(reward: VotingReward, tokenId: bigint): Promise<bigint> {
  const c = publicClient();
  let total = 0n;
  for (const t of reward.tokens) {
    total += (await c.readContract({
      address: reward.contract, abi: votingRewardAbi, functionName: "earned", args: [t, tokenId],
    })) as bigint;
  }
  return total;
}
