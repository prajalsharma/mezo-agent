import { encodeFunctionData, parseEther, parseUnits, formatUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { borrowerOperationsAbi, troveManagerAbi } from "../abis/mezo.js";
import { erc20Abi } from "../abis/erc20.js";
import { publicClient } from "../chain/client.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import { txnFee, musdToken } from "./fees.js";
import type { BorrowIntent, RepayIntent, AdjustIntent } from "../llm/intent.js";

// Live BTC/USD pricing is shared with the natural-language layer (dollar
// amounts) — see src/core/prices.ts.
import { btcPriceUsd as readBtcPriceUsd } from "../core/prices.js";

/** Current Trove collateral (BTC) and debt (MUSD) for an owner. undefined if unreadable. */
export async function readTrove(owner: Address): Promise<{ collBTC: number; debtMUSD: number } | undefined> {
  if (!registry.hasContract("TroveManager")) return undefined;
  try {
    const tm = registry.contract("TroveManager");
    const [coll, debt] = await Promise.all([
      publicClient().readContract({ address: tm, abi: troveManagerAbi, functionName: "getTroveColl", args: [owner] }) as Promise<bigint>,
      publicClient().readContract({ address: tm, abi: troveManagerAbi, functionName: "getTroveDebt", args: [owner] }) as Promise<bigint>,
    ]);
    return { collBTC: Number(formatUnits(coll, 18)), debtMUSD: Number(formatUnits(debt, 18)) };
  } catch {
    return undefined;
  }
}

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
      `Preview only - Mezo Borrow isn't wired on this deployment yet ` +
      `(${missing.join(", ")} not in the canonical reference). Calldata is built to the ` +
      `Liquity interface and will execute once these addresses are confirmed.`,
  });
}

export async function buildBorrow(intent: BorrowIntent, owner?: Address): Promise<ActionPlan> {
  const collateralBTC = Number(intent.collateralBTC);
  const mintMUSD = Number(intent.mintMUSD);
  if (collateralBTC <= 0) throw new ActionUnavailableError("Collateral must be greater than zero.");
  if (mintMUSD < MIN_NET_DEBT_MUSD) {
    throw new ActionUnavailableError(
      `Mezo requires a minimum net debt of ${MIN_NET_DEBT_MUSD} MUSD. Increase the amount to mint.`,
    );
  }

  // Can this wallet actually post the collateral? Collateral is NATIVE BTC, so
  // it also has to leave room for gas. Without this the bot built a fully valid,
  // well-collateralised plan the wallet could not fund, and the user paid gas to
  // watch openTrove revert (same gap the zap surface had).
  if (owner) {
    const need = parseUnits(intent.collateralBTC, 18);
    const held = await publicClient().getBalance({ address: owner }).catch(() => 0n);
    const GAS_HEADROOM = 500_000_000_000_000n; // ~0.0005 BTC, matches the swap path
    if (held < need + GAS_HEADROOM) {
      throw new ActionUnavailableError(
        `Not enough BTC to post as collateral: you have ${formatUnits(held, 18)} BTC and this needs ` +
          `${intent.collateralBTC} BTC plus gas. Fund the wallet, or lower the collateral (which also lowers how much you can mint).`,
      );
    }
  }

  const fee = mintMUSD * 0.01;
  const grossDebt = mintMUSD + fee;
  const summary = [
    `Deposit collateral: ${intent.collateralBTC} BTC`,
    `Mint: ${intent.mintMUSD} MUSD`,
    `Borrowing fee (est. 1%): ~${fee.toFixed(2)} MUSD`,
    `Total debt incl. fee: ~${grossDebt.toFixed(2)} MUSD`,
  ];
  const warnings = [
    `Keep your collateral ratio above the ${(MCR * 100).toFixed(0)}% minimum or the Trove can be liquidated.`,
  ];

  if (NEEDED.some((k) => !registry.hasContract(k))) {
    return borrowGated("🏦 Borrow MUSD (open Trove)", "borrow", summary, warnings);
  }

  // Live collateral-ratio check against the on-chain BTC price. Blocks an
  // under-collateralized borrow HERE with exact numbers (min BTC / max mint), so
  // the user never confirms an impossible Trove. Fail-open: if the price can't be
  // read, we skip the check and let the pre-Confirm simulation catch it instead.
  const btcPrice = await readBtcPriceUsd();
  if (btcPrice !== undefined) {
    const collateralUsd = collateralBTC * btcPrice;
    const icr = collateralUsd / grossDebt; // ratio (1.0 = 100%)
    const ok = icr >= MCR;
    summary.push(
      `Collateral ratio: ~${(icr * 100).toFixed(0)}% ${ok ? "✅" : "❌"} (min ${(MCR * 100).toFixed(0)}%, BTC ~$${Math.round(btcPrice).toLocaleString()})`,
    );
    if (ok) {
      // Plain-language risk line (research: Brian/HeyAnon pattern) — the ONE
      // number a borrower must know, computed, never generated.
      const liqPrice = (MCR * grossDebt) / collateralBTC;
      warnings.unshift(
        `If BTC falls below ~$${Math.round(liqPrice).toLocaleString()}, this Trove can be liquidated and you lose the collateral.`,
      );
    }
    if (!ok) {
      const minColl = (MCR * grossDebt) / btcPrice;
      const maxNetMint = collateralUsd / MCR / 1.01;
      const hint =
        maxNetMint >= MIN_NET_DEBT_MUSD
          ? `The most you can borrow with ${intent.collateralBTC} BTC is ~${Math.floor(maxNetMint).toLocaleString()} MUSD.`
          : `${intent.collateralBTC} BTC isn't enough to open a Trove at all (minimum debt is ${MIN_NET_DEBT_MUSD.toLocaleString()} MUSD).`;
      throw new ActionUnavailableError(
        `Under-collateralized. ${intent.collateralBTC} BTC (~$${Math.round(collateralUsd).toLocaleString()}) can't back ` +
          `${intent.mintMUSD} MUSD debt - the 110% minimum needs ~$${Math.round(MCR * grossDebt).toLocaleString()} of collateral. ` +
          `To mint ${intent.mintMUSD} MUSD you'd need ≥ ${minColl.toFixed(4)} BTC. ${hint} ` +
          `Tip: aim for 150%+ so a price dip doesn't liquidate you.`,
      );
    }
  } else {
    warnings.push("Live collateral ratio is computed from the on-chain price immediately before signing.");
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

export async function buildRepay(intent: RepayIntent, owner: Address): Promise<ActionPlan> {
  const repay = Number(intent.repayMUSD);
  if (repay <= 0) throw new ActionUnavailableError("Repay amount must be greater than zero.");
  const summary = [`Repay: ${intent.repayMUSD} MUSD`, `Reduces your Trove debt and improves your collateral ratio.`];

  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("💵 Repay MUSD", "repay", summary);
  }

  // Trove-existence + amount sanity check BEFORE building an approval the user
  // would otherwise sign for nothing. Without an open Trove there is nothing to
  // repay — the protocol reverts with "Trove does not exist", which is exactly
  // the confusing path a user with no loan hits. Fail-open if unreadable.
  const trove = await readTrove(owner);
  if (trove) {
    if (trove.debtMUSD <= 0) {
      throw new ActionUnavailableError(
        "You don't have an open Trove, so there's nothing to repay. (You'd open one with a borrow first.)",
      );
    }
    if (repay > trove.debtMUSD) {
      throw new ActionUnavailableError(
        `You asked to repay ${intent.repayMUSD} MUSD but your Trove debt is only ~${Math.round(trove.debtMUSD).toLocaleString()} MUSD. ` +
          `To clear it all and get your collateral back, use "close trove".`,
      );
    }
    const remaining = trove.debtMUSD - repay;
    if (remaining > 0 && remaining < MIN_NET_DEBT_MUSD) {
      throw new ActionUnavailableError(
        `Repaying ${intent.repayMUSD} MUSD would leave ~${Math.round(remaining).toLocaleString()} MUSD debt, below the ${MIN_NET_DEBT_MUSD.toLocaleString()} MUSD minimum. ` +
          `Repay less, or use "close trove" to repay it all at once.`,
      );
    }
    summary.push(`Trove debt after: ~${Math.round(remaining).toLocaleString()} MUSD`);
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

export async function buildAdjust(intent: AdjustIntent, owner: Address): Promise<ActionPlan> {
  const addColl = intent.addCollateralBTC ? Number(intent.addCollateralBTC) : 0;
  const withdrawColl = intent.withdrawCollateralBTC ? Number(intent.withdrawCollateralBTC) : 0;
  const mint = intent.mintMUSD ? Number(intent.mintMUSD) : 0;
  const repay = intent.repayMUSD ? Number(intent.repayMUSD) : 0;
  if (addColl + withdrawColl + mint + repay === 0) {
    throw new ActionUnavailableError("Nothing to adjust - specify collateral or debt change.");
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

  // Resulting collateral-ratio check. The generic pre-Confirm simulation can't
  // catch this: adjust runs ratio-IMPROVING steps first, so the ratio-lowering
  // step (mint/withdraw) is last and step-0 simulation looks fine. Read the
  // current Trove + price, apply the delta, and block if it would drop below MCR
  // — with real numbers. Fail-open on any unreadable read.
  const trove = await readTrove(owner);
  const price = await readBtcPriceUsd();
  if (trove && price !== undefined) {
    if (trove.debtMUSD <= 0) {
      throw new ActionUnavailableError("You don't have an open Trove to adjust. Use borrow to open one first.");
    }
    const newColl = trove.collBTC + addColl - withdrawColl;
    const newDebt = trove.debtMUSD + mint * 1.01 - repay; // new mint carries ~1% borrow fee
    if (newColl <= 0) throw new ActionUnavailableError("That withdrawal would remove more collateral than the Trove holds.");
    const newIcr = (newColl * price) / newDebt;
    const ok = newDebt <= 0 || newIcr >= MCR;
    summary.push(`Resulting collateral ratio: ~${(newIcr * 100).toFixed(0)}% ${ok ? "✅" : "❌"} (min ${(MCR * 100).toFixed(0)}%)`);
    if (!ok) {
      throw new ActionUnavailableError(
        `That adjustment would drop your collateral ratio to ~${(newIcr * 100).toFixed(0)}% - below the ${(MCR * 100).toFixed(0)}% minimum, which the protocol rejects. ` +
          `Add more BTC, mint less, or repay some MUSD first. (Current: ${trove.collBTC.toFixed(4)} BTC / ${Math.round(trove.debtMUSD).toLocaleString()} MUSD.)`,
      );
    }
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

export async function buildCloseTrove(owner: Address): Promise<ActionPlan> {
  const summary = [
    "Repays the full MUSD debt and returns your BTC collateral.",
    "You must hold enough MUSD to cover the outstanding debt.",
  ];

  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("🔒 Close Trove", "closeTrove", summary);
  }

  // Pre-check: an open Trove must exist, and the user must hold enough MUSD to
  // cover the full debt (closeTrove burns the debt from their balance). Both
  // surfaced as plain messages before signing. Fail-open if unreadable.
  const trove = await readTrove(owner);
  if (trove) {
    if (trove.debtMUSD <= 0) {
      throw new ActionUnavailableError("You don't have an open Trove to close.");
    }
    summary.push(`Outstanding debt to repay: ~${Math.round(trove.debtMUSD).toLocaleString()} MUSD`);
    const musd = registry.erc20Of("MUSD");
    if (musd) {
      try {
        const bal = (await publicClient().readContract({
          address: musd, abi: erc20Abi, functionName: "balanceOf", args: [owner],
        })) as bigint;
        const musdHeld = Number(formatUnits(bal, 18));
        if (musdHeld < trove.debtMUSD) {
          throw new ActionUnavailableError(
            `Closing needs ~${Math.round(trove.debtMUSD).toLocaleString()} MUSD to clear the debt, but you hold ~${Math.round(musdHeld).toLocaleString()} MUSD. ` +
              `Acquire the difference (e.g. swap into MUSD) or repay down first.`,
          );
        }
      } catch (err) {
        if (err instanceof ActionUnavailableError) throw err;
        // read hiccup — fail open, simulation backstops it
      }
    }
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
    describe: "Close Trove - repay all debt, withdraw all collateral",
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
