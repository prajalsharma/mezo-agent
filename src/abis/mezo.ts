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
] as const;

export const troveManagerAbi = [
  { type: "function", name: "getCurrentICR", stateMutability: "view", inputs: [
    { name: "_borrower", type: "address" }, { name: "_price", type: "uint256" },
  ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTroveColl", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTroveDebt", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTroveStatus", stateMutability: "view", inputs: [{ name: "_borrower", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const priceFeedAbi = [
  { type: "function", name: "fetchPrice", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastGoodPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
  { type: "function", name: "claimBribes", stateMutability: "nonpayable", inputs: [
    { name: "_bribes", type: "address[]" }, { name: "_tokens", type: "address[][]" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [
    { name: "_fees", type: "address[]" }, { name: "_tokens", type: "address[][]" }, { name: "_tokenId", type: "uint256" },
  ], outputs: [] },
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
