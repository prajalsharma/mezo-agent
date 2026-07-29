import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { gaugeAbi, voterAbi } from "../abis/mezo.js";
import { erc20Abi } from "../abis/erc20.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
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

/** Live gauge lookup via the Voter. Returns undefined when no gauge exists. */
async function gaugeFor(poolAddr: Address): Promise<Address | undefined> {
  const voter = registry.contract("Voter");
  const g = (await publicClient().readContract({
    address: voter, abi: voterAbi, functionName: "gauges", args: [poolAddr],
  })) as Address;
  return g && g.toLowerCase() !== ZERO_ADDR ? g : undefined;
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
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet." });
  }

  const gauge = await gaugeFor(p.address);
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
      erc20: { symbol: `${pair} LP`, amount }, waitForReceipt: true,
    },
    {
      kind: "stake", to: gauge, value: 0n,
      data: encodeFunctionData({ abi: gaugeAbi, functionName: "deposit", args: [amount] }),
      describe: `Stake ${formatUnits(amount, 18)} ${pair} LP into gauge`,
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
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet." });
  }

  const gauge = await gaugeFor(p.address);
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

export function buildVaultDeposit(intent: VaultDepositIntent): ActionPlan {
  const token = registry.tryToken(intent.token);
  if (!token) throw new ActionUnavailableError(`Unknown token "${intent.token}".`);
  if (Number(intent.amount) <= 0) throw new ActionUnavailableError("Amount must be greater than zero.");
  return gatedPlan({
    action: "vaultDeposit", title: "🏛️ Vault deposit",
    summary: [`Deposit ${intent.amount} ${token.symbol} into the Mezo Earn vault.`, `You receive vault shares that accrue yield.`],
    reason: "Preview only — Earn vault addresses aren't published in the canonical reference yet.",
  });
}

export async function buildClaim(intent: ClaimIntent, owner: Address): Promise<ActionPlan> {
  const scopeLabel = { all: "all rewards", rebase: "rebases", gauge: "gauge/LP earnings", bribe: "voting bribes" }[intent.scope];
  const summary = [`Claim ${scopeLabel} across your positions.`];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "claim", title: "🎁 Claim rewards", summary,
      reason: "Preview only — the Voter address isn't confirmed on this deployment yet." });
  }

  // Gauge scope executes live: enumerate the registry's pools, resolve each
  // gauge from the Voter, and claim wherever `earned(owner) > 0`. Rebase and
  // bribe scopes need the caller's veNFT ids (indexer/enumeration) and remain
  // gated — stated per-scope rather than blanket-gating "claim all".
  const steps: ActionStep[] = [];
  const targets: Address[] = [];
  if (intent.scope === "all" || intent.scope === "gauge") {
    for (const p of registry.pools()) {
      const gauge = await gaugeFor(p.address);
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

  if (steps.length === 0) {
    if (intent.scope === "gauge" || intent.scope === "all") {
      const note = intent.scope === "all"
        ? " (rebase/bribe claims additionally need your veNFT id — say e.g. \"claim rebases for veNFT 3\" once supported)"
        : "";
      throw new ActionUnavailableError(`Nothing to claim from gauges right now${note}.`);
    }
    return gatedPlan({ action: "claim", title: "🎁 Claim rewards", summary,
      reason: "Preview only — rebase/bribe claim enumeration needs your veNFT ids (indexer); gauge claims are live via \"claim gauge\"." });
  }

  if (intent.scope === "all") {
    summary.push("Rebase/bribe claims need veNFT enumeration (indexer) and are not included yet — this claims all gauge earnings.");
  }
  return {
    action: "claim", title: "🎁 Claim rewards", summary,
    warnings: [], steps, allowedTargets: targets, executable: true, nativeValue: 0n,
  };
}

/** Encode a gauge deposit once the gauge address is known (used by zap/stake). */
export function gaugeDepositStep(gauge: Address, amount: bigint, label: string): ActionStep {
  return {
    kind: "stake", to: gauge, value: 0n,
    data: encodeFunctionData({ abi: gaugeAbi, functionName: "deposit", args: [amount] }),
    describe: label,
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
