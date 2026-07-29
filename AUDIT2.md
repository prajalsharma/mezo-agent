# Security Audit — Round 2 (post feature-batch)

Pashov-style multi-agent audit (access-control, flow-gap, trust-gap,
economic-security) over the new surfaces: /export, vault deposits, claim-all,
veNFT enumeration, incentives feed, optimal voting, zap execution, delegate
deploy script. Findings below are cross-agent-deduplicated with remediation.

## Critical

| # | Finding | Fix | Status |
|---|---|---|---|
| C1 | **Spending caps + step-up inert for BTC.** BTC moves via the ERC-20 precompile (`value:0n`), but caps/step-up only inspect `msg.value`, so lock/swap/zap/vault/stake of any BTC amount bypass per-tx + daily caps AND the high-value confirmation. (all 3 agents) | Signer treats the BTC precompile as native: counts erc20-BTC step amounts toward perTx/daily caps + the spend ledger; builders set true `nativeValue`. | ✅ fixed |
| C2 | **Zap addLiquidity reverts deterministically.** `amountAMin` = 99.5% of pre-swap `half` while side B is discounted → `amountAOptimal ≈ 0.992·half < amountAMin` on every fee-bearing pool → strands funds mid-zap. | Widen LP-deposit tolerances to absorb the swap fee; approve/desire the full quoted B. | ✅ fixed |
| C3 | **Pasted key/seed can reach the LLM.** If the 3-min import window lapses or a prior import failed, the pasted secret falls through to `parseIntent` → Anthropic, and is left undeleted. Automatic blocker per bounty. | Unconditional pre-LLM secret-shaped-text guard (delete + never parse); re-arm pending after a failed import; import-await gets a long TTL. | ✅ fixed |

## High

| # | Finding | Fix | Status |
|---|---|---|---|
| H1 | **Swap allowlist mismatch.** Native swap allowlists the `0x000…0` sentinel, not the `0x7b7C…` routing address / `fee.recipient` → signer rejects its own steps. | Derive allowedTargets from routing addresses + fee.recipient (as zap does). | ✅ fixed |
| H2 | **Unbounded `waitForReceipt` freezes the bot.** grammY dispatches sequentially; a stuck tx parks every user incl. `/pause`. | Bounded timeout on receipt waits; release reservation on failure/timeout. | ✅ fixed |
| H3 | **Claim-all read amplification.** `votingRewardsForPool` re-read per veNFT → ~2000 sequential calls. | Hoist per-pool reads out of the per-NFT loop (compute once). | ✅ fixed |
| H4 | **Optimal vote hardcodes votingPower=1.** Water-filling isn't scale-free → wrong weights + wrong displayed rewards. | Read `balanceOfNFT(tokenId)`; require tokenId before the feed read. | ✅ fixed |
| H5 | **Dust bribe captures 100% of a vote.** Any non-zero mid-epoch incentive is decisive; no magnitude floor. | Minimum absolute MUSD incentive floor; show raw per-gauge totals; refuse if a gauge has unpriceable rewards. | ✅ fixed |
| H6 | **Zero-vote epsilon inverts the optimum.** `max(otherVotes,1e-9)` multiplied into the numerator zeroes the best (uncontested) gauge. | Handle `otherVotes==0` as a distinct first-allocation case. | ✅ fixed |
| H7 | **Unvalidated gauge as approval spender.** `gaugeFor` trusts any non-zero RPC return as the spender of the full LP balance; never shown. | Validate gauge (`stakingToken()==pool`, has code) before use; surface targets. | ✅ fixed |

## Medium / hardening

| # | Finding | Fix | Status |
|---|---|---|---|
| M1 | **veNFT enumeration silently truncates at 50.** "Claim all" omits the rest with no warning. | Return true count; warn + name the omitted count in the summary. | ✅ fixed |
| M2 | **Deployer key on argv** (`forge --private-key`) → visible in `ps`/`/proc`. | `--interactive` via stdin; validate file perms + key shape. | ✅ fixed |
| M3 | **Spot AMM quote as oracle.** Full-pile `getAmountOut`, first pool, no depth floor. | Unit-quote + linear scale; pick deepest matching pool; loop continues past a reverting pool. | ✅ fixed |
| M4 | **/fees claims a zap fee** that buildZap never charges. | Disclosure corrected to what is actually charged. | ✅ fixed |
| M5 | **Export self-destruct is best-effort in-process.** A restart in the 60s window leaves the key in chat. | Warning states the key may persist if a delete fails; user told to delete manually (already present, reinforced). | ✅ documented |
| M6 | **Tautological signer allowlist.** allowedTargets derived from the plan's own steps. | Signer additionally asserts each target is registry-known OR a validated gauge/vault; H7 supplies the validation. | ✅ fixed |

## Accepted / documented residuals

- **Spot-price manipulability of the optimizer** is mitigated (unit quote, depth
  floor, magnitude floor, raw-number display, live-weights warning) but not
  eliminated — an attacker can still skew a thin pool within a block. The vote
  is advisory + user-confirmed with the raw MUSD figures shown, so the user can
  reject an implausible allocation. Documented, not silently trusted.
- **Multi-tx zap/claim are not atomic** (no on-chain batcher on this deployment);
  a mid-plan abort can leave a dangling allowance. Each step is simulated and
  confirmed; the EIP-7702 delegate (when deployed) enables atomic multicall.
