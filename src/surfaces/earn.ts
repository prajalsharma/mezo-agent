import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { gaugeAbi, voterAbi, rewardsDistributorAbi } from "../abis/mezo.js";
import { ownedVeNftsDetailed, claimableRebase, votingRewardsForPool, earnedAcross } from "../core/veEnumeration.js";
import { erc20Abi } from "../abis/erc20.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import { txnFee } from "./fees.js";
import { attest } from "../custody/attest.js";
import type { VaultDepositIntent, StakeLpIntent, UnstakeLpIntent, ClaimIntent } from "../llm/intent.js";

/**
 * Earn surface — deposit into vaults, stake/unstake LP into gauges, and claim
 * rewards. Gauges are resolved LIVE from the Voter (`gauges(pool)`) at build
 * time — never hardcoded — so a pool without a gauge is a named refusal, not a
 * guess. (Mainnet note: the Voter is deployed but had zero gauges at wiring
 * time, so stake/claim are live code awaiting protocol state there; testnet has
 * active gauges and executes end-to-end.)
 */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function pool(poolId: string) {
  const p = registry.resolvePool(...(poolId.split("/") as [string, string]));
  if (!p) {
    const avail = registry.pools().map((x) => x.pair.join("/")).join(", ") || "none";
    throw new ActionUnavailableError(`Unknown pool "${poolId}". Available: ${avail}.`);
  }
  return p;
}

/**
 * Live gauge lookup via the Voter, VALIDATED before use. The Voter address is
 * registry-verified, but its `gauges()` return is an RPC read that then becomes
 * the spender of the user's whole LP balance — so we confirm the gauge has code
 * and that its `stakingToken()` is exactly this pool before trusting it as an
 * approval target. A spoofed/unexpected address fails the identity check rather
 * than draining the LP. (Audit R2 H7.) Returns undefined when no gauge exists.
 */
async function gaugeFor(poolAddr: Address, owner: Address): Promise<Address | undefined> {
  const voter = registry.contract("Voter");
  const g = (await publicClient().readContract({
    address: voter, abi: voterAbi, functionName: "gauges", args: [poolAddr],
  })) as Address;
  if (!g || g.toLowerCase() === ZERO_ADDR) return undefined;

  const code = await publicClient().getCode({ address: g });
  if (!code || code === "0x") {
    throw new ActionUnavailableError("The resolved gauge address has no code - refusing to use it.");
  }
  const staking = (await publicClient().readContract({
    address: g, abi: gaugeAbi, functionName: "stakingToken",
  }).catch(() => ZERO_ADDR)) as Address;
  if (staking.toLowerCase() !== poolAddr.toLowerCase()) {
    throw new ActionUnavailableError(
      `Gauge identity check failed (stakingToken != pool) - refusing to approve or stake against it.`,
    );
  }
  // A gauge is discovered at runtime, so it cannot be in the compiled-in
  // registry — but it HAS just been proven to be the real gauge for this pool.
  // Record that, so the signer's independent target check accepts it on the
  // strength of the verification rather than on the plan's say-so.
  attest(owner, g, `gauge for pool ${poolAddr} (stakingToken verified)`);
  return g;
}

export async function buildStakeLp(intent: StakeLpIntent, owner: Address): Promise<ActionPlan> {
  const p = pool(intent.pool);
  const pair = p.pair.join("/");
  const summary = [
    `Stake ${intent.amount ? intent.amount + " " : "your full "}LP for ${pair}`,
    `Staked LP earns MEZO emissions from the pool's gauge.`,
  ];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "stakeLp", title: "🌱 Stake LP", summary,
      reason: "Preview only - the Voter address isn't confirmed on this deployment yet." });
  }

  const gauge = await gaugeFor(p.address, owner);
  if (!gauge) {
    throw new ActionUnavailableError(
      `No gauge exists for ${pair} on ${registry.networkName()} yet (Voter.gauges returned zero). ` +
      `Staking activates when the protocol creates one.`,
    );
  }

  // LP token == the pool contract itself (Velodrome pools are ERC-20 LPs).
  const balance = (await publicClient().readContract({
    address: p.address, abi: erc20Abi, functionName: "balanceOf", args: [owner],
  })) as bigint;
  const amount = intent.amount ? parseUnits(intent.amount, 18) : balance;
  if (amount <= 0n) throw new ActionUnavailableError(`You hold no ${pair} LP to stake.`);
  if (amount > balance) {
    throw new ActionUnavailableError(
      `You asked to stake ${intent.amount} LP but hold ${formatUnits(balance, 18)}.`,
    );
  }

  const steps: ActionStep[] = [
    {
      kind: "approval", to: p.address, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [gauge, amount] }),
      describe: `Approve ${formatUnits(amount, 18)} ${pair} LP for the gauge`,
      erc20: { symbol: `${pair} LP`, amount, kind: "approval" }, waitForReceipt: true,
    },
    {
      kind: "stake", to: gauge, value: 0n,
      data: encodeFunctionData({ abi: gaugeAbi, functionName: "deposit", args: [amount] }),
      describe: `Stake ${formatUnits(amount, 18)} ${pair} LP into gauge`,
      erc20: { symbol: `${pair} LP`, amount, kind: "spend" },
    },
  ];
  return {
    action: "stakeLp", title: "🌱 Stake LP", summary,
    warnings: [], steps, allowedTargets: [p.address, gauge], executable: true, nativeValue: 0n,
  };
}

export async function buildUnstakeLp(intent: UnstakeLpIntent, owner: Address): Promise<ActionPlan> {
  const p = pool(intent.pool);
  const pair = p.pair.join("/");
  const summary = [`Unstake ${intent.amount ? intent.amount + " " : "all "}LP from the ${pair} gauge.`];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "unstakeLp", title: "🍂 Unstake LP", summary,
      reason: "Preview only - the Voter address isn't confirmed on this deployment yet." });
  }

  const gauge = await gaugeFor(p.address, owner);
  if (!gauge) throw new ActionUnavailableError(`No gauge exists for ${pair} on ${registry.networkName()}.`);

  const staked = (await publicClient().readContract({
    address: gauge, abi: gaugeAbi, functionName: "balanceOf", args: [owner],
  })) as bigint;
  const amount = intent.amount ? parseUnits(intent.amount, 18) : staked;
  if (amount <= 0n) throw new ActionUnavailableError(`You have no ${pair} LP staked in the gauge.`);
  if (amount > staked) {
    throw new ActionUnavailableError(
      `You asked to unstake ${intent.amount} LP but have ${formatUnits(staked, 18)} staked.`,
    );
  }

  const step: ActionStep = {
    kind: "unstake", to: gauge, value: 0n,
    data: encodeFunctionData({ abi: gaugeAbi, functionName: "withdraw", args: [amount] }),
    describe: `Unstake ${formatUnits(amount, 18)} ${pair} LP from gauge`,
  };
  return {
    action: "unstakeLp", title: "🍂 Unstake LP", summary,
    warnings: [], steps: [step], allowedTargets: [gauge], executable: true, nativeValue: 0n,
  };
}

export function buildVaultDeposit(intent: VaultDepositIntent, owner: Address): ActionPlan {
  const token = registry.tryToken(intent.token);
  if (!token) throw new ActionUnavailableError(`Unknown token "${intent.token}".`);
  if (Number(intent.amount) <= 0) throw new ActionUnavailableError("Amount must be greater than zero.");

  const vault = registry.vaultForAsset(token.symbol);
  if (!vault) {
    const avail = registry.vaults().map((v) => `${v.assetSymbol} → ${v.name}`).join("; ") || "none on this network";
    throw new ActionUnavailableError(
      `No published vault takes ${token.symbol} deposits. Available: ${avail}.`,
    );
  }

  const amount = parseUnits(intent.amount, token.decimals);
  const summary = [
    `Deposit ${intent.amount} ${token.symbol} into ${vault.name}.`,
    `You receive vault shares that accrue yield; withdraw any time (subject to vault liquidity).`,
  ];
  // Two deposit shapes, both verified on-chain against the implementation's
  // selector table (see VaultInfo.kind). Receiver is always the caller — the
  // agent must never be able to route shares elsewhere.
  const depositData =
    vault.kind === "savings"
      ? encodeFunctionData({
          abi: [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "_amount", type: "uint256" }], outputs: [] }] as const,
          functionName: "deposit", args: [amount],
        })
      : encodeFunctionData({
          abi: [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
          functionName: "deposit", args: [amount, owner],
        });

  // Agent fee (Mezo-approved) on the deposit, taken in the deposit token AFTER
  // the deposit confirms.
  const agentFee = txnFee(token, amount);
  if (agentFee.summaryLine) summary.push(agentFee.summaryLine);
  const steps: ActionStep[] = [
    approveStep(token.address, vault.address, amount, token.symbol),
    {
      kind: "vaultDeposit", to: vault.address, value: 0n,
      data: depositData,
      describe: `Deposit ${intent.amount} ${token.symbol} into ${vault.name}`,
      erc20: { symbol: token.symbol, amount, kind: "spend" },
      waitForReceipt: agentFee.step !== undefined,
    },
    ...(agentFee.step ? [agentFee.step] : []),
  ];
  return {
    action: "vaultDeposit", title: "🏛️ Vault deposit", summary,
    warnings: ["Vault yield is variable; withdrawals can be limited when utilization is high."],
    steps, allowedTargets: [token.address, vault.address, ...(agentFee.target ? [agentFee.target] : [])], executable: true, nativeValue: 0n,
  };
}

export async function buildClaim(intent: ClaimIntent, owner: Address): Promise<ActionPlan> {
  const scopeLabel = { all: "all rewards", rebase: "rebases", gauge: "gauge/LP earnings", bribe: "voting bribes + fees" }[intent.scope];
  const summary = [`Claim ${scopeLabel} across your positions.`];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "claim", title: "🎁 Claim rewards", summary,
      reason: "Preview only - the Voter address isn't confirmed on this deployment yet." });
  }

  // The bounty's "claim everything" flow: one confirmed plan aggregating
  //   • gauge/LP emissions        — gauge.getReward(owner)
  //   • rebases                   — RewardsDistributor.claim(tokenId) per veNFT
  //   • voting bribes + fees      — Voter.claimBribes/claimFees(..., tokenId)
  // Everything enumerated live; only positive-balance claims become steps, so
  // the user never signs a no-op.
  const steps: ActionStep[] = [];
  const targets: Address[] = [];

  if (intent.scope === "all" || intent.scope === "gauge") {
    for (const p of registry.pools()) {
      const gauge = await gaugeFor(p.address, owner);
      if (!gauge) continue;
      const earned = (await publicClient().readContract({
        address: gauge, abi: gaugeAbi, functionName: "earned", args: [owner],
      })) as bigint;
      if (earned <= 0n) continue;
      steps.push({
        kind: "claim", to: gauge, value: 0n,
        data: encodeFunctionData({ abi: gaugeAbi, functionName: "getReward", args: [owner] }),
        describe: `Claim ~${formatUnits(earned, 18)} MEZO from the ${p.pair.join("/")} gauge`,
      });
      targets.push(gauge);
    }
  }

  if (intent.scope === "all" || intent.scope === "rebase" || intent.scope === "bribe") {
    const owned = registry.hasContract("VotingEscrowBTC")
      ? await ownedVeNftsDetailed(owner)
      : { ids: [], total: 0n, truncated: false };
    const veNfts = owned.ids;
    if (owned.truncated) {
      summary.push(
        `⚠️ You hold ${owned.total} veNFTs; only the first ${veNfts.length} are included. Claim again for the rest.`,
      );
    }

    if ((intent.scope === "all" || intent.scope === "rebase") && registry.hasContract("RewardsDistributor")) {
      const rd = registry.contract("RewardsDistributor");
      for (const id of veNfts) {
        const claimable = await claimableRebase(id);
        if (claimable <= 0n) continue;
        steps.push({
          kind: "claimRebase", to: rd, value: 0n,
          data: encodeFunctionData({ abi: rewardsDistributorAbi, functionName: "claim", args: [id] }),
          describe: `Claim ~${formatUnits(claimable, 18)} BTC rebase for veNFT #${id}`,
        });
        targets.push(rd);
      }
    }

    if (intent.scope === "all" || intent.scope === "bribe") {
      const voter = registry.contract("Voter");
      // Resolve each pool's bribe/fee contracts ONCE (they're NFT-independent);
      // the previous code re-read them per veNFT, turning claim-all into ~2000
      // sequential RPC calls that an attacker could inflate by gifting the
      // victim dust veNFTs. (Audit R2 H3/H11.)
      const poolRewards = await Promise.all(
        registry.pools().map((p) => votingRewardsForPool(p.address)),
      );
      for (const id of veNfts) {
        const bribes: Address[] = []; const bribeTokens: Address[][] = [];
        const fees: Address[] = []; const feeTokens: Address[][] = [];
        for (const { bribe, fee } of poolRewards) {
          if (bribe && (await earnedAcross(bribe, id)) > 0n) { bribes.push(bribe.contract); bribeTokens.push(bribe.tokens); }
          if (fee && (await earnedAcross(fee, id)) > 0n) { fees.push(fee.contract); feeTokens.push(fee.tokens); }
        }
        if (bribes.length > 0) {
          steps.push({
            kind: "claimBribes", to: voter, value: 0n,
            data: encodeFunctionData({ abi: voterAbi, functionName: "claimBribes", args: [bribes, bribeTokens, id] }),
            describe: `Claim voting bribes for veNFT #${id} (${bribes.length} pool${bribes.length > 1 ? "s" : ""})`,
          });
          targets.push(voter);
        }
        if (fees.length > 0) {
          steps.push({
            kind: "claimFees", to: voter, value: 0n,
            data: encodeFunctionData({ abi: voterAbi, functionName: "claimFees", args: [fees, feeTokens, id] }),
            describe: `Claim trading-fee share for veNFT #${id} (${fees.length} pool${fees.length > 1 ? "s" : ""})`,
          });
          targets.push(voter);
        }
      }
      if (veNfts.length === 0 && intent.scope === "bribe") {
        throw new ActionUnavailableError("You hold no veNFTs, so there are no voting bribes or fees to claim. Lock BTC first (e.g. \"lock 0.01 BTC for 28 days\").");
      }
    }
  }

  if (steps.length === 0) {
    throw new ActionUnavailableError(
      `Nothing claimable right now for ${scopeLabel} - all live balances are zero.`,
    );
  }

  // Bound the plan so a griefer who gifted the user many dust veNFTs can't make
  // "claim all" a 150-transaction, unbounded-gas confirmation. (Audit R2 H11.)
  const MAX_CLAIM_STEPS = 20;
  const trimmed = steps.length > MAX_CLAIM_STEPS;
  const finalSteps = trimmed ? steps.slice(0, MAX_CLAIM_STEPS) : steps;
  if (trimmed) {
    summary.push(
      `⚠️ ${steps.length} claimable items found; this plan claims the first ${MAX_CLAIM_STEPS}. Run "claim all" again for the rest. ` +
        `(A large count can mean dust positions were sent to your account.)`,
    );
  }

  return {
    action: "claim", title: "🎁 Claim rewards", summary,
    warnings: [`This plan is ${finalSteps.length} separate transaction(s); each is simulated before signing.`],
    steps: finalSteps, allowedTargets: [...new Set(finalSteps.map((s) => s.to))], executable: true, nativeValue: 0n,
  };
}

/** Encode a gauge deposit once the gauge address is known (used by zap/stake). */
export function gaugeDepositStep(gauge: Address, amount: bigint, label: string, lpSymbol = "LP"): ActionStep {
  return {
    kind: "stake", to: gauge, value: 0n,
    data: encodeFunctionData({ abi: gaugeAbi, functionName: "deposit", args: [amount] }),
    describe: label,
    erc20: { symbol: lpSymbol, amount, kind: "spend" },
  };
}

/** Encode an ERC-20 approval step. */
export function approveStep(token: Address, spender: Address, amount: bigint, symbol: string): ActionStep {
  return {
    kind: "approval", to: token, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    describe: `Approve ${symbol}`, erc20: { symbol, amount }, waitForReceipt: true,
  };
}

export { parseUnits, voterAbi, gaugeFor };
