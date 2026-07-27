import { encodeFunctionData, parseUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { gaugeAbi, voterAbi } from "../abis/mezo.js";
import { erc20Abi } from "../abis/erc20.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import type { VaultDepositIntent, StakeLpIntent, UnstakeLpIntent, ClaimIntent } from "../llm/intent.js";

/**
 * Earn surface — deposit into vaults, stake/unstake LP into gauges, and claim
 * rewards across surfaces. Gauges are resolved from the Voter (never hardcoded);
 * rewards are claimed generically because they arrive in a mix of tokens.
 */

function pool(poolId: string) {
  const p = registry.resolvePool(...(poolId.split("/") as [string, string]));
  if (!p) {
    const avail = registry.pools().map((x) => x.pair.join("/")).join(", ") || "none";
    throw new ActionUnavailableError(`Unknown pool "${poolId}". Available: ${avail}.`);
  }
  return p;
}

export function buildStakeLp(intent: StakeLpIntent): ActionPlan {
  const p = pool(intent.pool);
  const summary = [
    `Stake ${intent.amount ? intent.amount + " " : "your full "}LP for ${p.pair.join("/")}`,
    `Staked LP earns MEZO emissions from the pool's gauge.`,
  ];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "stakeLp", title: "🌱 Stake LP", summary,
      reason: "Preview only — the Voter/gauge address isn't confirmed on this deployment yet." });
  }
  // The gauge for this pool is read from the Voter at execution time; encoding
  // requires that lookup, so we keep this gated until Voter is configured.
  return gatedPlan({ action: "stakeLp", title: "🌱 Stake LP", summary,
    reason: "Preview only — gauge resolution via Voter activates once its address is confirmed." });
}

export function buildUnstakeLp(intent: UnstakeLpIntent): ActionPlan {
  const p = pool(intent.pool);
  return gatedPlan({
    action: "unstakeLp", title: "🍂 Unstake LP",
    summary: [`Unstake ${intent.amount ? intent.amount + " " : "all "}LP from the ${p.pair.join("/")} gauge.`],
    reason: "Preview only — the Voter/gauge address isn't confirmed on this deployment yet.",
  });
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

export function buildClaim(intent: ClaimIntent): ActionPlan {
  const scopeLabel = { all: "all rewards", rebase: "rebases", gauge: "gauge/LP earnings", bribe: "voting bribes" }[intent.scope];
  const summary = [
    `Claim ${scopeLabel} across your positions.`,
    `Rewards arrive in a mix of tokens (BTC + ERC-20s) and are claimed generically.`,
  ];
  if (!registry.hasContract("Voter")) {
    return gatedPlan({ action: "claim", title: "🎁 Claim rewards", summary,
      reason: "Preview only — reward contracts (Voter/RewardsDistributor) aren't confirmed on this deployment yet." });
  }
  // Live claim enumerates the user's gauges/bribes from the indexer, then calls
  // getReward/claimBribes/claimFees. That enumeration needs the indexer wired.
  return gatedPlan({ action: "claim", title: "🎁 Claim rewards", summary,
    reason: "Preview only — claim enumeration activates with the indexer + confirmed reward addresses." });
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

export { parseUnits, voterAbi };
