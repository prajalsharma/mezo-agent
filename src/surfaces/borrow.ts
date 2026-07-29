import { encodeFunctionData, parseEther, parseUnits, formatUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { borrowerOperationsAbi } from "../abis/mezo.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import { txnFee, musdToken } from "./fees.js";
import type { BorrowIntent, RepayIntent, AdjustIntent } from "../llm/intent.js";

/**
 * Borrow surface — Mezo Borrow / MUSD (Liquity-style CDP). Open a Trove by
 * depositing native BTC collateral and minting MUSD; adjust, repay, or close.
 *
 * Deterministic guardrails the model is never trusted to enforce:
 *   • minimum net debt 1,800 MUSD, MCR 110% (README §2),
 *   • borrowing fee (from 1%) surfaced before confirm,
 *   • upper/lower hints are fetched FRESH immediately before submit (never here,
 *     never cached) — so a live plan requires HintHelpers + SortedTroves too.
 */

const MIN_NET_DEBT_MUSD = 1_800;
const MCR = 1.1; // 110%
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const NEEDED = ["BorrowerOperations", "HintHelpers", "SortedTroves", "PriceFeed"] as const;

function borrowGated(title: string, action: string, summary: string[], warnings: string[] = []): ActionPlan {
  const missing = NEEDED.filter((k) => !registry.hasContract(k));
  return gatedPlan({
    action, title, summary, warnings,
    reason:
      `Preview only — Mezo Borrow isn't wired on this deployment yet ` +
      `(${missing.join(", ")} not in the canonical reference). Calldata is built to the ` +
      `Liquity interface and will execute once these addresses are confirmed.`,
  });
}

export function buildBorrow(intent: BorrowIntent): ActionPlan {
  const collateralBTC = Number(intent.collateralBTC);
  const mintMUSD = Number(intent.mintMUSD);
  if (collateralBTC <= 0) throw new ActionUnavailableError("Collateral must be greater than zero.");
  if (mintMUSD < MIN_NET_DEBT_MUSD) {
    throw new ActionUnavailableError(
      `Mezo requires a minimum net debt of ${MIN_NET_DEBT_MUSD} MUSD. Increase the amount to mint.`,
    );
  }

  const fee = mintMUSD * 0.01;
  const summary = [
    `Deposit collateral: ${intent.collateralBTC} BTC`,
    `Mint: ${intent.mintMUSD} MUSD`,
    `Borrowing fee (est. 1%): ~${fee.toFixed(2)} MUSD`,
    `Total debt incl. fee: ~${(mintMUSD + fee).toFixed(2)} MUSD`,
  ];
  const warnings = [
    `Keep your collateral ratio above the ${(MCR * 100).toFixed(0)}% minimum or the Trove can be liquidated.`,
    `Live collateral ratio is computed from the on-chain price immediately before signing.`,
  ];

  if (NEEDED.some((k) => !registry.hasContract(k))) {
    return borrowGated("🏦 Borrow MUSD (open Trove)", "borrow", summary, warnings);
  }

  const bo = registry.contract("BorrowerOperations");
  // Agent fee (Mezo-approved) on the minted MUSD, charged AFTER the Trove opens.
  const agentFee = txnFee(musdToken(), parseUnits(intent.mintMUSD, 18));
  if (agentFee.summaryLine) summary.push(agentFee.summaryLine);
  // Hints are placeholders here; the executor refreshes them via HintHelpers just
  // before submit. Zero hints are valid fallbacks (linear scan from head).
  const step: ActionStep = {
    kind: "openTrove",
    to: bo,
    data: encodeFunctionData({
      abi: borrowerOperationsAbi,
      functionName: "openTrove",
      args: [parseUnits(intent.mintMUSD, 18), ZERO, ZERO],
    }),
    value: parseEther(intent.collateralBTC),
    describe: `Open Trove: ${intent.collateralBTC} BTC → ${intent.mintMUSD} MUSD`,
    // Wait for the Trove to open (and MUSD to be minted) before charging the fee.
    waitForReceipt: agentFee.step !== undefined,
  };
  const steps = agentFee.step ? [step, agentFee.step] : [step];
  return {
    action: "borrow", title: "🏦 Borrow MUSD (open Trove)", summary, warnings,
    steps, allowedTargets: [bo, ...(agentFee.target ? [agentFee.target] : [])], executable: true, nativeValue: step.value,
  };
}

export function buildRepay(intent: RepayIntent): ActionPlan {
  const repay = Number(intent.repayMUSD);
  if (repay <= 0) throw new ActionUnavailableError("Repay amount must be greater than zero.");
  const summary = [`Repay: ${intent.repayMUSD} MUSD`, `Reduces your Trove debt and improves your collateral ratio.`];

  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("💵 Repay MUSD", "repay", summary);
  }
  const bo = registry.contract("BorrowerOperations");
  const musd = registry.erc20Of("MUSD");
  const steps: ActionStep[] = [];
  if (musd) {
    steps.push({
      kind: "approval", to: musd, value: 0n,
      data: encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }] as const, functionName: "approve", args: [bo, parseUnits(intent.repayMUSD, 18)] }),
      describe: `Approve ${intent.repayMUSD} MUSD`, erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD, 18) }, waitForReceipt: true,
    });
  }
  steps.push({
    kind: "repayMUSD", to: bo, value: 0n,
    data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "repayMUSD", args: [parseUnits(intent.repayMUSD, 18), ZERO, ZERO] }),
    describe: `Repay ${intent.repayMUSD} MUSD`,
  });
  return { action: "repay", title: "💵 Repay MUSD", summary, warnings: [], steps, allowedTargets: [bo, ...(musd ? [musd] : [])], executable: true, nativeValue: 0n };
}

export function buildAdjust(intent: AdjustIntent): ActionPlan {
  const addColl = intent.addCollateralBTC ? Number(intent.addCollateralBTC) : 0;
  const withdrawColl = intent.withdrawCollateralBTC ? Number(intent.withdrawCollateralBTC) : 0;
  const mint = intent.mintMUSD ? Number(intent.mintMUSD) : 0;
  const repay = intent.repayMUSD ? Number(intent.repayMUSD) : 0;
  if (addColl + withdrawColl + mint + repay === 0) {
    throw new ActionUnavailableError("Nothing to adjust — specify collateral or debt change.");
  }
  if (addColl > 0 && withdrawColl > 0) throw new ActionUnavailableError("Can't add and withdraw collateral in one action.");
  if (mint > 0 && repay > 0) throw new ActionUnavailableError("Can't mint and repay in one action.");

  const summary: string[] = [];
  if (addColl) summary.push(`Add collateral: +${intent.addCollateralBTC} BTC`);
  if (withdrawColl) summary.push(`Withdraw collateral: −${intent.withdrawCollateralBTC} BTC`);
  if (mint) summary.push(`Mint more MUSD: +${intent.mintMUSD}`);
  if (repay) summary.push(`Repay MUSD: −${intent.repayMUSD}`);
  const warnings = ["Adjustments must keep the collateral ratio above 110%; the live ratio is checked before signing."];

  if (NEEDED.some((k) => !registry.hasContract(k))) {
    return borrowGated("🔧 Adjust Trove", "adjust", summary, warnings);
  }

  const bo = registry.contract("BorrowerOperations");
  const musd = registry.erc20Of("MUSD");
  const steps: ActionStep[] = [];

  // Order matters: anything that IMPROVES the collateral ratio runs first, so a
  // multi-part adjustment never dips below MCR midway and revert the whole plan.
  // Adding collateral and repaying debt both raise the ratio; withdrawing
  // collateral and minting both lower it.
  if (addColl > 0) {
    steps.push({
      kind: "addColl", to: bo, value: parseEther(intent.addCollateralBTC!),
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "addColl", args: [ZERO, ZERO] }),
      describe: `Add ${intent.addCollateralBTC} BTC collateral`,
    });
  }
  if (repay > 0) {
    if (musd) {
      steps.push({
        kind: "approval", to: musd, value: 0n,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
          functionName: "approve", args: [bo, parseUnits(intent.repayMUSD!, 18)],
        }),
        describe: `Approve ${intent.repayMUSD} MUSD`,
        erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD!, 18) },
        waitForReceipt: true,
      });
    }
    steps.push({
      kind: "repayMUSD", to: bo, value: 0n,
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "repayMUSD", args: [parseUnits(intent.repayMUSD!, 18), ZERO, ZERO] }),
      describe: `Repay ${intent.repayMUSD} MUSD`,
    });
  }
  if (withdrawColl > 0) {
    steps.push({
      kind: "withdrawColl", to: bo, value: 0n,
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "withdrawColl", args: [parseEther(intent.withdrawCollateralBTC!), ZERO, ZERO] }),
      describe: `Withdraw ${intent.withdrawCollateralBTC} BTC collateral`,
    });
  }
  if (mint > 0) {
    steps.push({
      kind: "withdrawMUSD", to: bo, value: 0n,
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "withdrawMUSD", args: [parseUnits(intent.mintMUSD!, 18), ZERO, ZERO] }),
      describe: `Mint ${intent.mintMUSD} MUSD`,
    });
  }

  const nativeValue = steps.reduce((sum, s) => sum + s.value, 0n);
  return {
    action: "adjust", title: "🔧 Adjust Trove", summary, warnings, steps,
    allowedTargets: [bo, ...(musd ? [musd] : [])], executable: true, nativeValue,
  };
}

export function buildCloseTrove(): ActionPlan {
  const summary = [
    "Repays the full MUSD debt and returns your BTC collateral.",
    "You must hold enough MUSD to cover the outstanding debt.",
  ];

  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("🔒 Close Trove", "closeTrove", summary);
  }

  const bo = registry.contract("BorrowerOperations");
  // No approval step: the exact debt is only knowable at execution time, and
  // pre-approving an unbounded amount would hand BorrowerOperations a standing
  // allowance far beyond this action — exactly what the per-token caps exist to
  // prevent. Simulation runs before signing, so an insufficient balance or
  // allowance surfaces as a decoded, human-readable failure instead of a
  // wasted transaction.
  const step: ActionStep = {
    kind: "closeTrove", to: bo, value: 0n,
    data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "closeTrove", args: [] }),
    describe: "Close Trove — repay all debt, withdraw all collateral",
  };
  return {
    action: "closeTrove", title: "🔒 Close Trove", summary,
    warnings: ["This repays your entire debt in one transaction. Ensure your MUSD balance covers it."],
    steps: [step], allowedTargets: [bo], executable: true, nativeValue: 0n,
  };
}

/** For display/tests: does the current deployment support live borrow execution? */
export function borrowExecutable(): boolean {
  return NEEDED.every((k) => registry.hasContract(k));
}
export { formatUnits };
