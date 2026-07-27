import { encodeFunctionData, parseEther, parseUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi } from "../abis/mezo.js";
import { approveStep } from "./earn.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import type { LockIntent, ExtendLockIntent } from "../llm/intent.js";

/**
 * Locking surface — veBTC (lock native BTC, 1–28 days) and veMEZO (lock MEZO,
 * up to 4 years). veBTC gives base voting power + a BTC-denominated fee claim;
 * veMEZO boosts a paired veBTC position up to 5× (see Matchbox). Extend adds
 * time and/or amount to an existing lock.
 */

const VE_BTC_MAX_DAYS = 28;
const VE_MEZO_MAX_DAYS = 4 * 365;
const DAY = 24 * 60 * 60;

export function buildLock(intent: LockIntent): ActionPlan {
  const amount = Number(intent.amount);
  if (amount <= 0) throw new ActionUnavailableError("Lock amount must be greater than zero.");
  const maxDays = intent.asset === "BTC" ? VE_BTC_MAX_DAYS : VE_MEZO_MAX_DAYS;
  if (intent.lockDays > maxDays) {
    throw new ActionUnavailableError(
      `${intent.asset} locks are capped at ${maxDays} days. Reduce the duration.`,
    );
  }
  const key = intent.asset === "BTC" ? "VotingEscrowBTC" : "VotingEscrowMEZO";
  const endDate = new Date(Date.now() + intent.lockDays * DAY * 1000).toISOString().slice(0, 10);
  const summary = [
    `Lock ${intent.amount} ${intent.asset} for ${intent.lockDays} days (unlocks ~${endDate}).`,
    intent.asset === "BTC"
      ? "veBTC gives voting power + a claim on protocol fees (paid largely in BTC)."
      : "veMEZO boosts a paired veBTC position up to 5× (pair it via Matchbox).",
  ];

  if (!registry.hasContract(key)) {
    return gatedPlan({ action: "lock", title: `🔒 Lock ${intent.asset} (ve${intent.asset})`, summary,
      reason: `Preview only — ${key} isn't confirmed on this deployment yet. Calldata is built to the VotingEscrow interface and executes once the address lands.` });
  }

  const ve = registry.contract(key);
  const duration = BigInt(intent.lockDays * DAY);
  const steps: ActionStep[] = [];
  let nativeValue = 0n;

  if (intent.asset === "BTC") {
    nativeValue = parseEther(intent.amount);
    steps.push({
      kind: "createLock", to: ve, value: nativeValue,
      data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "createLock", args: [duration] }),
      describe: `Lock ${intent.amount} BTC for ${intent.lockDays}d`,
    });
  } else {
    const mezo = registry.erc20Of("MEZO")!;
    const value = parseUnits(intent.amount, 18);
    steps.push(approveStep(mezo, ve, value, "MEZO"));
    steps.push({
      kind: "createLock", to: ve, value: 0n,
      data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "createLock", args: [value, duration] }),
      describe: `Lock ${intent.amount} MEZO for ${intent.lockDays}d`,
    });
  }
  return {
    action: "lock", title: `🔒 Lock ${intent.asset} (ve${intent.asset})`, summary, warnings: [],
    steps, allowedTargets: steps.map((s) => s.to), executable: true, nativeValue,
  };
}

export function buildExtendLock(intent: ExtendLockIntent): ActionPlan {
  if (!intent.addDays && !intent.addAmount) {
    throw new ActionUnavailableError("Specify more time (addDays) and/or more amount (addAmount).");
  }
  const summary: string[] = [`Extend lock #${intent.tokenId}:`];
  if (intent.addDays) summary.push(`• +${intent.addDays} days`);
  if (intent.addAmount) summary.push(`• +${intent.addAmount} to the locked amount`);
  return gatedPlan({
    action: "extendLock", title: "⏳ Extend lock", summary,
    reason: "Preview only — the VotingEscrow address isn't confirmed on this deployment yet.",
  });
}
