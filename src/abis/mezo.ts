/**
 * ABIs for Mezo's protocol contracts. Mezo's Borrow is a Liquity-style CDP and
 * its Earn stack is a Velodrome-style ve(3,3), so these are the standard fork
 * interfaces, trimmed to what the builders call. Addresses come from the
 * registry (gated until Mezo publishes them); these ABIs let the encoded
 * calldata + simulation be correct the moment an address lands.
 *
 * Market/Matchbox interfaces are best-effort pending Mezo's published ABIs and
 * are only reached when their addresses are configured.
 */

// ── Borrow (Liquity fork) ────────────────────────────────────────────────────
export const borrowerOperationsAbi = [
  // NOTE: Mezo's MUSD fork drops Liquity's leading `_maxFeePercentage` argument
  // from openTrove and withdrawMUSD. Using the upstream Liquity 4-arg form
  // produces a selector no function matches, so the call reverts with NO reason
  // string — which is easy to misread as a balance or collateral-ratio problem.
  // Signatures verified against mezo-org/musd IBorrowerOperations.sol and
  // confirmed by simulation (a correct selector yields a decoded protocol
  // revert such as "BorrowerOps: Trove does not exist or is closed").
  { type: "function", name: "openTrove", stateMutability: "payable", inputs: [
    { name: "_debtAmount", type: "uint256" },
    { name: "_upperHint", type: "address" },
    { name: "_lowerHint", type: "address" },
  ], outputs: [] },
  { type: "function", name: "addColl", stateMutability: "payable", inputs: [
    { name: "_upperHint", type: "address" }, { name: "_lowerHint", type: "address" },
  ], outputs: [] },
  { type: "function", name: "withdrawColl", stateMutability: "nonpayable", inputs: [
    { name: "_amount", type: "uint256" }, { name: "_upperHint", type: "address" }, { name: "_lowerHint", type: "address" },
  ], outputs: [] },
  { type: "function", name: "withdrawMUSD", stateMutability: "nonpayable", inputs: [
    { name: "_amount", type: "uint256" },
    { name: "_upperHint", type: "address" }, { name: "_lowerHint", type: "address" },
  ], outputs: [] },
  { type: "function", name: "repayMUSD", stateMutability: "nonpayable", inputs: [
    { name: "_amount", type: "uint256" }, { name: "_upperHint", type: "address" }, { name: "_lowerHint", type: "address" },
  ], outputs: [] },
  { type: "function", name: "closeTrove", stateMutability: "nonpayable", inputs: [], outputs: [] },
  // Redeemed borrowers must claim their collateral surplus themselves; the
  // protocol does not push it back. Verified live: calling it with nothing owed
  // reverts "CollSurplusPool: No collateral available to claim".
  { type: "function", name: "claimCollateral", stateMutability: "nonpayable", inputs: [], outputs: [] },
  // Live market parameters. Every one of these was a hardcoded constant in the
  // borrow surface until the conformance audit; several had drifted from the
  // deployed contracts (see src/core/musdParams.ts). All verified on testnet:
  // gas comp 200e18, borrowingRate 1e15 (0.1%), minNetDebt 1800e18, MCR 1.1e18,
  // CCR 1.5e18.
  { type: "function", name: "MUSD_GAS_COMPENSATION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowingRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minNetDebt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MCR", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CCR", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const troveManagerAbi = [
  { type: "function", name: "getCurrentICR", stateMutability: "view", inputs: [
    { name: "_borrower", type: "address" }, { name: "_price", type: "uint256" },
  ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTroveColl", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
  // Includes principal + accrued interest + gas compensation.
  { type: "function", name: "getTroveDebt", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
  // A Solidity enum, so it ABI-encodes as uint8 - not the uint256 this used to
  // declare. Values: 0 nonExistent, 1 active, 2 closedByOwner, 3 closedByLiquidation,
  // 4 closedByRedemption. Without it, a liquidated or redeemed Trove is
  // indistinguishable from never having had one.
  { type: "function", name: "getTroveStatus", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint8" }] },
  // The sticky borrowing high-water mark stamped at open time. Verified live on
  // TroveManager (NOT BorrowerOperations, where the selector does not exist).
  { type: "function", name: "getTroveMaxBorrowingCapacity", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
  // System-wide state: in Recovery Mode opens are gated on CCR, not MCR, and
  // the borrowing fee is waived.
  { type: "function", name: "checkRecoveryMode", stateMutability: "view", inputs: [{ name: "_price", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getTCR", stateMutability: "view", inputs: [{ name: "_price", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

// `fetchPrice` is `view` on-chain, and it is the ONLY price selector that
// exists. `lastGoodPrice` used to be declared here and used as the sole address
// probe in scripts/verifyaddrs.ts - it appears in musd only as an EVENT
// parameter, so the probe silently failed on both networks and PriceFeed was
// never actually verified. Removed rather than left as a decoy.
export const priceFeedAbi = [
  { type: "function", name: "fetchPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const hintHelpersAbi = [
  { type: "function", name: "getApproxHint", stateMutability: "view", inputs: [
    { name: "_CR", type: "uint256" }, { name: "_numTrials", type: "uint256" }, { name: "_inputRandomSeed", type: "uint256" },
  ], outputs: [{ name: "hintAddress", type: "address" }, { name: "diff", type: "uint256" }, { name: "latestRandomSeed", type: "uint256" }] },
] as const;

// ── Earn: VotingEscrow / Voter / Gauge (Velodrome fork) ──────────────────────
export const votingEscrowAbi = [
  // Both escrows use the ERC-20 form. veBTC locks native BTC via its ERC-20
  // precompile (0x7b7C…0000): approve the precompile to the escrow, then
  // createLock(value, duration). Verified by simulation — the on-chain veBTC
  // has NO payable 1-arg variant (that call reverts opaquely), while the 2-arg
  // call reaches SafeERC20.transferFrom (decoded allowance failure).
  { type: "function", name: "createLock", stateMutability: "nonpayable", inputs: [
    { name: "_value", type: "uint256" }, { name: "_lockDuration", type: "uint256" },
  ], outputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "function", name: "increaseAmount", stateMutability: "nonpayable", inputs: [
    { name: "_tokenId", type: "uint256" }, { name: "_value", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "increaseUnlockTime", stateMutability: "nonpayable", inputs: [
    { name: "_tokenId", type: "uint256" }, { name: "_lockDuration", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "merge", stateMutability: "nonpayable", inputs: [
    { name: "_from", type: "uint256" }, { name: "_to", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [
    { name: "_from", type: "address" }, { name: "_to", type: "address" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "balanceOfNFT", stateMutability: "view", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  // Enumeration — verified live: balanceOf(owner) + ownerToNFTokenIdList(owner, i).
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerToNFTokenIdList", stateMutability: "view", inputs: [
    { name: "_owner", type: "address" }, { name: "_index", type: "uint256" },
  ], outputs: [{ type: "uint256" }] },
] as const;

export const voterAbi = [
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [
    { name: "_tokenId", type: "uint256" }, { name: "_poolVote", type: "address[]" }, { name: "_weights", type: "uint256[]" },
  ], outputs: [] },
  { type: "function", name: "gauges", stateMutability: "view", inputs: [{ name: "_pool", type: "address" }], outputs: [{ type: "address" }] },
  // Per-gauge reward contracts (verified live on the production Voter).
  { type: "function", name: "gaugeToFees", stateMutability: "view", inputs: [{ name: "_gauge", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "gaugeToBribe", stateMutability: "view", inputs: [{ name: "_gauge", type: "address" }], outputs: [{ type: "address" }] },
  // Weights — for the optimal-vote incentives feed.
  { type: "function", name: "weights", stateMutability: "view", inputs: [{ name: "_pool", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalWeight", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // The FULL gauge set. The allocator used to iterate the 3 pools in the
  // registry and describe the result as "optimal", while mainnet carries 26
  // gauges holding ~80% of totalWeight — so it was confidently optimising over
  // a fifth of the universe. These let it at least MEASURE what it cannot see.
  // Verified live on both Voters.
  { type: "function", name: "length", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pools", stateMutability: "view", inputs: [{ name: "_index", type: "uint256" }], outputs: [{ type: "address" }] },
  // Vote-mechanics limits the builder never read, so breaching them reverted
  // opaquely AFTER signing.
  { type: "function", name: "maxVotingNum", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastVoted", stateMutability: "view", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochVoteEnd", stateMutability: "view", inputs: [{ name: "_timestamp", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimBribes", stateMutability: "nonpayable", inputs: [
    { name: "_bribes", type: "address[]" }, { name: "_tokens", type: "address[][]" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [
    { name: "_fees", type: "address[]" }, { name: "_tokens", type: "address[][]" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [] },
] as const;

/**
 * BoostVoter — the on-chain veBTC/veMEZO matching primitive (what Matchbox.markets
 * is a UI over). A veMEZO holder directs their boost with vote(veMezoId, gauges,
 * weights); reset(veMezoId) clears it. Signatures verified against the
 * newtmex/mezo-abi deployment ABI; ve() == VeMEZO confirmed on-chain.
 */
export const boostVoterAbi = [
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [
    { name: "_tokenId", type: "uint256" }, { name: "_gaugeVote", type: "address[]" }, { name: "_weights", type: "uint256[]" },
  ], outputs: [] },
  { type: "function", name: "reset", stateMutability: "nonpayable", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [] },
] as const;

export const gaugeAbi = [
  // stakingToken() must equal the pool address — the identity check that stops a
  // spoofed Voter.gauges() return from becoming an approval spender (Audit R2 H7).
  { type: "function", name: "stakingToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "_amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "_amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [{ name: "_account", type: "address" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "_account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "earned", stateMutability: "view", inputs: [{ name: "_account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const rewardsDistributorAbi = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ name: "_tokenId", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

// ── Router: liquidity (Velodrome fork) ───────────────────────────────────────
export const routerLiquidityAbi = [
  { type: "function", name: "addLiquidity", stateMutability: "nonpayable", inputs: [
    { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "stable", type: "bool" },
    { name: "amountADesired", type: "uint256" }, { name: "amountBDesired", type: "uint256" },
    { name: "amountAMin", type: "uint256" }, { name: "amountBMin", type: "uint256" },
    { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }, { name: "liquidity", type: "uint256" }] },
  { type: "function", name: "quoteAddLiquidity", stateMutability: "view", inputs: [
    { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "stable", type: "bool" },
    { name: "_factory", type: "address" }, { name: "amountADesired", type: "uint256" }, { name: "amountBDesired", type: "uint256" },
  ], outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }, { name: "liquidity", type: "uint256" }] },
] as const;

// ── Market / Matchbox (best-effort; reached only when addresses are set) ─────
export const marketAbi = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ name: "_listingId", type: "uint256" }], outputs: [] },
  { type: "function", name: "listingPrice", stateMutability: "view", inputs: [{ name: "_listingId", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const matchboxAbi = [
  { type: "function", name: "pair", stateMutability: "nonpayable", inputs: [
    { name: "_veBtcId", type: "uint256" }, { name: "_veMezoId", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "unpair", stateMutability: "nonpayable", inputs: [{ name: "_veBtcId", type: "uint256" }], outputs: [] },
] as const;

// Velodrome-style voting-rewards contract (bribes + fees share this shape).
export const votingRewardAbi = [
  { type: "function", name: "rewardsListLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rewards", stateMutability: "view", inputs: [{ name: "_index", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "earned", stateMutability: "view", inputs: [
    { name: "_token", type: "address" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenRewardsPerEpoch", stateMutability: "view", inputs: [
    { name: "_token", type: "address" }, { name: "_epochStart", type: "uint256" },
  ], outputs: [{ type: "uint256" }] },
] as const;
