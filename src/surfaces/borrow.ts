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
import { btcPriceWad } from "../core/prices.js";
import {
  musdParams, recoveryMode, maxBorrowingCapacity,
  compositeDebt, borrowingFee, requiredCR, maxNetMint, liquidationPrice, icrOf, pct,
  type MusdParams,
} from "../core/musdParams.js";

/** Trove lifecycle status. A closed Trove is not the same as never having one. */
export type TroveStatus = "none" | "active" | "closedByOwner" | "liquidated" | "redeemed";

const STATUS: TroveStatus[] = ["none", "active", "closedByOwner", "liquidated", "redeemed"];

/** Current Trove collateral (BTC) and debt (MUSD) for an owner. undefined if unreadable. */
export async function readTrove(owner: Address): Promise<{ collBTC: number; debtMUSD: number } | undefined> {
  const raw = await readTroveRaw(owner);
  if (!raw) return undefined;
  return { collBTC: Number(formatUnits(raw.coll, 18)), debtMUSD: Number(formatUnits(raw.debt, 18)) };
}

/**
 * The Trove in the protocol's own units, plus its lifecycle status.
 *
 * `debt` is the COMPOSITE debt — principal + accrued interest + the 200 MUSD gas
 * compensation. Everything downstream has to know that, because the two numbers
 * a borrower cares about are derived differently from it: `closeTrove` burns
 * `debt - gasCompensation` from their wallet, while the minimum-net-debt floor
 * is measured against `debt - gasCompensation` as well.
 */
export async function readTroveRaw(
  owner: Address,
): Promise<{ coll: bigint; debt: bigint; status: TroveStatus } | undefined> {
  if (!registry.hasContract("TroveManager")) return undefined;
  try {
    const tm = registry.contract("TroveManager");
    const call = (functionName: string) =>
      publicClient().readContract({ address: tm, abi: troveManagerAbi, functionName: functionName as never, args: [owner] });
    const [coll, debt, status] = await Promise.all([
      call("getTroveColl") as Promise<bigint>,
      call("getTroveDebt") as Promise<bigint>,
      call("getTroveStatus").catch(() => 0) as Promise<number | bigint>,
    ]);
    return { coll, debt, status: STATUS[Number(status)] ?? "none" };
  } catch {
    return undefined;
  }
}

/**
 * Borrow surface — Mezo Borrow / MUSD (Liquity-style CDP). Open a Trove by
 * depositing native BTC collateral and minting MUSD; adjust, repay, or close.
 *
 * Every protocol number here is READ FROM THE PROTOCOL (src/core/musdParams.ts).
 * They used to be compile-time constants, and the constants were wrong: the
 * borrowing fee was hardcoded at 1% against a live 0.1%, and the 200 MUSD gas
 * compensation was missing from the debt that `openTrove` actually gates on. The
 * net effect was a card that said "110% ✅" for a Trove sitting at 99% that would
 * revert, with a liquidation price up to 10% too optimistic.
 *
 * Deterministic guardrails the model is never trusted to enforce:
 *   • live minimum net debt and live MCR/CCR, never constants,
 *   • Recovery Mode: opens gate on CCR (150%) and the fee is waived,
 *   • the Trove's sticky maxBorrowingCapacity bounds every mint,
 *   • an unreadable or stale price BLOCKS rather than skipping the ratio check,
 *   • upper/lower hints are passed as ZERO. That is a valid Liquity fallback -
 *     the protocol falls back to a linear scan from the list head - and with the
 *     low Trove counts on Mezo today it costs little. It is NOT the "hints are
 *     fetched fresh immediately before submit via HintHelpers" this file used to
 *     claim: getApproxHint is never called anywhere in the codebase.
 */

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Read the live parameters, the live price, and the live system state, or refuse. */
async function marketOrRefuse(): Promise<{ p: MusdParams; priceWad: bigint; inRecovery: boolean }> {
  const [p, priceWad] = await Promise.all([musdParams(), btcPriceWad()]);
  if (!p) {
    throw new ActionUnavailableError(
      "Can't read Mezo's live borrowing parameters (fee, minimum debt, collateral ratio) right now, " +
        "so I won't guess them - the numbers on the card would be wrong in the direction that gets people liquidated. Try again in a moment.",
    );
  }
  if (priceWad === undefined) {
    throw new ActionUnavailableError(
      "The BTC price feed is stale or unreadable, so I can't check your collateral ratio. " +
        "Mezo rejects Trove operations on a stale oracle too, so this transaction would fail on-chain anyway. Try again in a minute.",
    );
  }
  // `?? false` was assuming "normal" on an unreadable read — exactly what
  // musdParams.recoveryMode's own doc says callers must not do. During Recovery
  // Mode WITH a failed TroveManager read, that gated a new Trove on MCR (110%)
  // when the protocol requires CCR (150%): a green card, then a revert, in the
  // market conditions where users are most stressed. Refuse instead; the whole
  // point of this function is that it is the one place allowed to say no.
  const inRecovery = await recoveryMode(priceWad);
  if (inRecovery === undefined) {
    throw new ActionUnavailableError(
      "I can't tell whether Mezo is in Recovery Mode right now, and that changes the collateral ratio " +
        "this would be judged against (150% instead of 110%). I won't show you a ratio that might be " +
        "measured against the wrong threshold - try again in a moment.",
    );
  }
  return { p, priceWad, inRecovery };
}

/** 1e18-scaled MUSD → "1,800" / "2,001.80". Never scientific notation. */
function fmtMusd(wad: bigint): string {
  const n = Number(formatUnits(wad, 18));
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });
}

/** 1e18-scaled USD → "63,416". */
function fmtUsd(wad: bigint): string {
  return Math.round(Number(formatUnits(wad, 18))).toLocaleString("en-US");
}

/** 1e18-scaled rate → "0.1%". */
function fmtRate(wad: bigint): string {
  const p = (Number(wad) / 1e18) * 100;
  return `${p < 1 ? p.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : p.toFixed(2)}%`;
}

/**
 * Refuse, and say WHICH kind of "no Trove" this is.
 *
 * A liquidated Trove and a redeemed Trove used to render identically to "you
 * never opened one" — the single most confusing thing the bot could tell someone
 * whose position just disappeared, and it also hid the fact that a redeemed
 * borrower has collateral sitting in the surplus pool waiting to be claimed.
 */
function assertHasTrove(status: TroveStatus, debt: bigint, verb: string): void {
  if (status === "active" && debt > 0n) return;
  if (status === "liquidated") {
    throw new ActionUnavailableError(
      `Your Trove was LIQUIDATED - its collateral ratio fell below the minimum, so the debt was cleared and the ` +
        `collateral was taken. There's nothing to ${verb}. If any collateral surplus is owed to you, say "claim collateral".`,
    );
  }
  if (status === "redeemed") {
    throw new ActionUnavailableError(
      `Your Trove was REDEEMED - someone exchanged MUSD for its collateral at face value, which the protocol fills ` +
        `starting from the lowest collateral ratio. There's nothing to ${verb}. Any leftover collateral is yours: say "claim collateral".`,
    );
  }
  if (status === "closedByOwner") {
    throw new ActionUnavailableError(`You closed this Trove already, so there's nothing to ${verb}.`);
  }
  throw new ActionUnavailableError(
    `You don't have an open Trove, so there's nothing to ${verb}. (You'd open one with a borrow first.)`,
  );
}

/** Redemption is ranked, not absolute - the risk line has to say so. */
const REDEMPTION_NOTE =
  "MUSD redemptions are filled from the LOWEST collateral ratio upward, so a thin Trove can have its debt " +
  "repaid and its collateral taken even while it is perfectly healthy. Any leftover collateral is not returned " +
  'automatically - you claim it with "claim collateral".';

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
  const collWad = parseEther(intent.collateralBTC);
  const mintWad = parseUnits(intent.mintMUSD, 18);
  if (collWad <= 0n) throw new ActionUnavailableError("Collateral must be greater than zero.");

  const summaryDraft = [
    `Deposit collateral: ${intent.collateralBTC} BTC`,
    `Mint: ${intent.mintMUSD} MUSD`,
  ];
  if (NEEDED.some((k) => !registry.hasContract(k))) {
    return borrowGated("🏦 Borrow MUSD (open Trove)", "borrow", summaryDraft);
  }

  // Live parameters and a live price, or nothing. Everything below is arithmetic
  // over these — none of it is safe against a guessed fee or a stale oracle.
  const { p, priceWad, inRecovery } = await marketOrRefuse();

  if (mintWad < p.minNetDebt) {
    throw new ActionUnavailableError(
      `Mezo requires a minimum net debt of ${fmtMusd(p.minNetDebt)} MUSD. Increase the amount to mint.`,
    );
  }

  // Can this wallet actually post the collateral? Collateral is NATIVE BTC, so
  // it also has to leave room for gas. Without this the bot built a fully valid,
  // well-collateralised plan the wallet could not fund, and the user paid gas to
  // watch openTrove revert (same gap the zap surface had).
  if (owner) {
    const held = await publicClient().getBalance({ address: owner }).catch(() => 0n);
    const GAS_HEADROOM = 500_000_000_000_000n; // ~0.0005 BTC, matches the swap path
    if (held < collWad + GAS_HEADROOM) {
      throw new ActionUnavailableError(
        `Not enough BTC to post as collateral: you have ${formatUnits(held, 18)} BTC and this needs ` +
          `${intent.collateralBTC} BTC plus gas. Fund the wallet, or lower the collateral (which also lowers how much you can mint).`,
      );
    }
  }

  // The debt the PROTOCOL will record: net mint + live borrowing fee + the
  // 200 MUSD gas compensation. openTrove divides collateral by exactly this.
  const fee = borrowingFee(mintWad, p, inRecovery);
  const debt = compositeDebt(mintWad, p, inRecovery);
  const required = requiredCR(p, inRecovery);
  const icr = icrOf(collWad, priceWad, debt);
  const collateralUsd = (collWad * priceWad) / 10n ** 18n;

  const summary = [
    ...summaryDraft,
    inRecovery
      ? "Borrowing fee: waived (the system is in Recovery Mode)"
      : `Borrowing fee (${fmtRate(p.borrowingRate)}): ~${fmtMusd(fee)} MUSD`,
    `Gas compensation held against the Trove: ${fmtMusd(p.gasCompensation)} MUSD`,
    `Total debt recorded: ~${fmtMusd(debt)} MUSD`,
  ];
  const warnings: string[] = [];
  if (inRecovery) {
    warnings.push(
      `⚠️ Mezo is in RECOVERY MODE. New Troves must open at ${pct(p.ccr)} or better (not the usual ${pct(p.mcr)}), ` +
        `and the whole system is closer to liquidations than normal.`,
    );
  }

  const ok = icr >= required;
  summary.push(
    `Collateral ratio: ~${pct(icr)} ${ok ? "✅" : "❌"} (min ${pct(required)}, BTC ~$${fmtUsd(priceWad)})`,
  );

  if (!ok) {
    const minColl = (required * debt) / priceWad;
    const headroom = maxNetMint(collWad, priceWad, p, inRecovery);
    const hint =
      headroom >= p.minNetDebt
        ? `The most you can borrow with ${intent.collateralBTC} BTC is ~${fmtMusd(headroom)} MUSD.`
        : `${intent.collateralBTC} BTC isn't enough to open a Trove at all (minimum debt is ${fmtMusd(p.minNetDebt)} MUSD, ` +
          `and every Trove also carries ${fmtMusd(p.gasCompensation)} MUSD of gas compensation).`;
    const neededUsd = (required * debt) / 10n ** 18n;
    throw new ActionUnavailableError(
      `Under-collateralized. ${intent.collateralBTC} BTC (~$${fmtUsd(collateralUsd)}) can't back ` +
        `${intent.mintMUSD} MUSD - with the ${fmtRate(p.borrowingRate)} fee and ${fmtMusd(p.gasCompensation)} MUSD gas ` +
        `compensation the recorded debt is ~${fmtMusd(debt)} MUSD, and the ${pct(required)} minimum needs ` +
        `~$${fmtUsd(neededUsd)} of collateral. ` +
        `To mint ${intent.mintMUSD} MUSD you'd need ≥ ${formatUnits(minColl, 18).slice(0, 8)} BTC. ${hint} ` +
        `Tip: aim for 150%+ so a price dip doesn't liquidate you.`,
    );
  }

  // The ONE number a borrower must know — computed from the real recorded debt,
  // never generated. It used to be up to 10% too low at small Troves, because it
  // divided by a debt that omitted the gas compensation.
  const liqPrice = liquidationPrice(collWad, debt, p);
  warnings.unshift(
    `If BTC falls below ~$${fmtUsd(liqPrice)}, this Trove can be liquidated: your debt is cleared, but the ` +
      `collateral is taken and you keep neither it nor the ${fmtMusd(p.gasCompensation)} MUSD gas compensation. ` +
      `Keep the ratio above ${pct(required)}.`,
  );
  warnings.push(REDEMPTION_NOTE);

  const bo = registry.contract("BorrowerOperations");
  // Agent fee (Mezo-approved) on the minted MUSD, charged AFTER the Trove opens.
  const agentFee = txnFee(musdToken(), parseUnits(intent.mintMUSD, 18));
  if (agentFee.summaryLine) summary.push(agentFee.summaryLine);
  // Zero hints: a valid Liquity fallback (the protocol linear-scans from the
  // list head). Nothing refreshes them later - see the note at the top of this
  // file. HintHelpers is still required in NEEDED because a deployment without
  // it is not a live Borrow deployment.
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
  const repayWad = parseUnits(intent.repayMUSD, 18);
  if (repayWad <= 0n) throw new ActionUnavailableError("Repay amount must be greater than zero.");
  const summary = [`Repay: ${intent.repayMUSD} MUSD`, `Reduces your Trove debt and improves your collateral ratio.`];

  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("💵 Repay MUSD", "repay", summary);
  }

  // Trove-existence + amount sanity check BEFORE building an approval the user
  // would otherwise sign for nothing. Without an open Trove there is nothing to
  // repay — the protocol reverts with "Trove does not exist", which is exactly
  // the confusing path a user with no loan hits.
  const trove = await readTroveRaw(owner);
  const p = await musdParams();
  if (trove && p) {
    assertHasTrove(trove.status, trove.debt, "repay");
    // The floor is on NET debt. Comparing the raw composite debt (which carries
    // the 200 MUSD gas compensation) against the same floor made the two repay
    // surfaces disagree, and blocked a legitimate ~200 MUSD band of repayments.
    const netDebt = trove.debt > p.gasCompensation ? trove.debt - p.gasCompensation : 0n;
    if (repayWad > netDebt) {
      throw new ActionUnavailableError(
        `You asked to repay ${intent.repayMUSD} MUSD but your repayable Trove debt is only ~${fmtMusd(netDebt)} MUSD ` +
          `(the ${fmtMusd(p.gasCompensation)} MUSD gas compensation is settled when you close, not repaid). ` +
          `To clear it all and get your collateral back, use "close trove".`,
      );
    }
    const remaining = netDebt - repayWad;
    if (remaining > 0n && remaining < p.minNetDebt) {
      throw new ActionUnavailableError(
        `Repaying ${intent.repayMUSD} MUSD would leave ~${fmtMusd(remaining)} MUSD of debt, below Mezo's ` +
          `${fmtMusd(p.minNetDebt)} MUSD minimum. Repay less, or use "close trove" to clear it all at once.`,
      );
    }
    summary.push(`Trove debt after: ~${fmtMusd(remaining)} MUSD (plus ${fmtMusd(p.gasCompensation)} MUSD gas compensation)`);
  }

  const bo = registry.contract("BorrowerOperations");
  const musd = registry.erc20Of("MUSD");
  const steps: ActionStep[] = [];
  if (musd) {
    steps.push({
      kind: "approval", to: musd, value: 0n,
      data: encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }] as const, functionName: "approve", args: [bo, parseUnits(intent.repayMUSD, 18)] }),
      describe: `Approve ${intent.repayMUSD} MUSD`, erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD, 18), kind: "approval" }, waitForReceipt: true,
    });
  }
  steps.push({
    kind: "repayMUSD", to: bo, value: 0n,
    data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "repayMUSD", args: [parseUnits(intent.repayMUSD, 18), ZERO, ZERO] }),
    describe: `Repay ${intent.repayMUSD} MUSD`,
    erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD, 18), kind: "spend" },
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
  // current Trove + live parameters, apply the delta, and block with real
  // numbers if the protocol would reject it.
  const { p, priceWad, inRecovery } = await marketOrRefuse();
  const trove = await readTroveRaw(owner);
  if (trove) {
    assertHasTrove(trove.status, trove.debt, "adjust");

    const addWad = intent.addCollateralBTC ? parseEther(intent.addCollateralBTC) : 0n;
    const withdrawWad = intent.withdrawCollateralBTC ? parseEther(intent.withdrawCollateralBTC) : 0n;
    const mintWad = intent.mintMUSD ? parseUnits(intent.mintMUSD, 18) : 0n;
    const repayWad = intent.repayMUSD ? parseUnits(intent.repayMUSD, 18) : 0n;

    if (withdrawWad > trove.coll) {
      throw new ActionUnavailableError("That withdrawal would remove more collateral than the Trove holds.");
    }
    const newColl = trove.coll + addWad - withdrawWad;
    // Live fee on the NEW mint only; existing debt already carries its own fee
    // and the gas compensation, both of which getTroveDebt already includes.
    const newDebt = trove.debt + mintWad + borrowingFee(mintWad, p, inRecovery) - repayWad;

    // THE MINIMUM-NET-DEBT FLOOR ON THE REPAY LEG.
    //
    // buildRepay enforces this; buildAdjust did not enforce it at all, so
    // "adjust … repay 300" against a net debt of 2,004 produced a green card
    // for a remainder of 1,704 that the protocol rejects. musd requires
    // `_getNetDebt(debt) - netDebtChange >= minNetDebt` on any debt DECREASE
    // (BorrowerOperations `_requireAtLeastMinNetDebt`), and the basis is NET
    // debt — the gas compensation is settled on close, never repaid — which is
    // the same distinction buildRepay already makes.
    if (repayWad > 0n) {
      const netDebtNow = trove.debt > p.gasCompensation ? trove.debt - p.gasCompensation : 0n;
      if (repayWad > netDebtNow) {
        throw new ActionUnavailableError(
          `You asked to repay ${intent.repayMUSD} MUSD but only ~${fmtMusd(netDebtNow)} MUSD of this Trove's debt ` +
            `is repayable (the ${fmtMusd(p.gasCompensation)} MUSD gas compensation is settled when you close it). ` +
            `Use "close trove" to clear the position entirely.`,
        );
      }
      const netRemaining = netDebtNow - repayWad + mintWad;
      if (netRemaining > 0n && netRemaining < p.minNetDebt) {
        throw new ActionUnavailableError(
          `That would leave ~${fmtMusd(netRemaining)} MUSD of debt, below Mezo's ${fmtMusd(p.minNetDebt)} MUSD minimum, ` +
            `which the protocol rejects. Repay at most ${fmtMusd(netDebtNow - p.minNetDebt + mintWad)} MUSD, ` +
            `or use "close trove" to clear it all at once.`,
        );
      }
    }

    // The sticky borrowing cap. This is the check whose absence made "add more
    // BTC to borrow more" actively wrong advice: the cap is stamped at open time
    // as coll*price/MCR and NEVER rises afterwards — not when BTC appreciates,
    // not when collateral is added. Only `refinance` re-stamps it. Without this,
    // any mint between the real headroom and the ratio-implied headroom passed
    // our card and reverted on-chain.
    if (mintWad > 0n) {
      const cap = await maxBorrowingCapacity(owner);
      if (cap !== undefined && cap > 0n) {
        const headroom = cap > trove.debt ? cap - trove.debt : 0n;
        summary.push(`Borrowing capacity left: ~${fmtMusd(headroom)} MUSD (cap ${fmtMusd(cap)} MUSD)`);
        if (newDebt > cap) {
          throw new ActionUnavailableError(
            `Mezo caps each Trove's total debt at the amount stamped when it opened - yours is ${fmtMusd(cap)} MUSD, ` +
              `and you currently owe ${fmtMusd(trove.debt)} MUSD, so you can mint about ${fmtMusd(headroom)} MUSD more. ` +
              `Adding collateral will NOT raise this cap and neither will a higher BTC price; only refinancing the Trove ` +
              `re-stamps it, which this bot doesn't do yet. Mint less, or close and reopen the Trove at today's price.`,
          );
        }
      }
    }

    const required = requiredCR(p, inRecovery);
    const newIcr = icrOf(newColl, priceWad, newDebt);
    const ok = newDebt <= 0n || newIcr >= required;
    summary.push(`Resulting collateral ratio: ~${pct(newIcr)} ${ok ? "✅" : "❌"} (min ${pct(required)})`);
    if (inRecovery) {
      warnings.push(`⚠️ Recovery Mode: adjustments are judged against ${pct(p.ccr)}, not the usual ${pct(p.mcr)}.`);
    }
    if (!ok) {
      throw new ActionUnavailableError(
        `That adjustment would drop your collateral ratio to ~${pct(newIcr)} - below the ${pct(required)} minimum, which the protocol rejects. ` +
          `Add more BTC, mint less, or repay some MUSD first. (Current: ${formatUnits(trove.coll, 18).slice(0, 8)} BTC / ${fmtMusd(trove.debt)} MUSD.)`,
      );
    }
    if (newDebt > 0n) {
      warnings.push(
        `After this, liquidation would come into range around $${fmtUsd(liquidationPrice(newColl, newDebt, p))} per BTC.`,
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
        erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD!, 18), kind: "approval" },
        waitForReceipt: true,
      });
    }
    steps.push({
      kind: "repayMUSD", to: bo, value: 0n,
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "repayMUSD", args: [parseUnits(intent.repayMUSD!, 18), ZERO, ZERO] }),
      describe: `Repay ${intent.repayMUSD} MUSD`,
      erc20: { symbol: "MUSD", amount: parseUnits(intent.repayMUSD!, 18), kind: "spend" },
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

  // Pre-check: an open Trove must exist, and the user must hold enough MUSD.
  //
  // closeTrove burns `debt - MUSD_GAS_COMPENSATION` from the wallet — the 200
  // MUSD gas compensation was posted by the protocol at open and is returned
  // from its own pool, not from the borrower. Demanding the full composite debt
  // here was too strict by exactly 200 MUSD, and refused closes the protocol
  // would have accepted.
  const trove = await readTroveRaw(owner);
  const p = await musdParams();
  if (trove && p) {
    assertHasTrove(trove.status, trove.debt, "close");
    const owedByBorrower = trove.debt > p.gasCompensation ? trove.debt - p.gasCompensation : 0n;
    summary.push(
      `Debt to clear from your wallet: ~${fmtMusd(owedByBorrower)} MUSD ` +
        `(total debt ${fmtMusd(trove.debt)} MUSD less ${fmtMusd(p.gasCompensation)} MUSD gas compensation)`,
    );
    const musd = registry.erc20Of("MUSD");
    if (musd) {
      try {
        const bal = (await publicClient().readContract({
          address: musd, abi: erc20Abi, functionName: "balanceOf", args: [owner],
        })) as bigint;
        if (bal < owedByBorrower) {
          throw new ActionUnavailableError(
            `Closing needs ~${fmtMusd(owedByBorrower)} MUSD to clear the debt, but you hold ~${fmtMusd(bal)} MUSD. ` +
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

/**
 * Claim collateral left in the surplus pool after a redemption or a Recovery-Mode
 * liquidation.
 *
 * The protocol holds this and never pushes it back, so a borrower whose Trove was
 * redeemed can be owed real BTC and have no idea. There is no pre-check here
 * beyond the contract's own: `claimCollateral` reverts with
 * "CollSurplusPool: No collateral available to claim", which the pre-signing
 * simulation decodes into that exact sentence — clearer than anything we could
 * infer, and one fewer read on a path most users take once.
 */
export async function buildClaimCollateral(owner: Address): Promise<ActionPlan> {
  const summary = [
    "Claims any BTC left over after your Trove was redeemed or liquidated.",
    "Nothing happens if you're owed nothing - the protocol simply says so.",
  ];
  if (!registry.hasContract("BorrowerOperations")) {
    return borrowGated("🪙 Claim collateral surplus", "claimCollateral", summary);
  }
  const trove = await readTroveRaw(owner).catch(() => undefined);
  if (trove && (trove.status === "redeemed" || trove.status === "liquidated")) {
    summary.unshift(`Your Trove was ${trove.status === "redeemed" ? "redeemed" : "liquidated"}.`);
  }
  const bo = registry.contract("BorrowerOperations");
  return {
    action: "claimCollateral",
    title: "🪙 Claim collateral surplus",
    summary,
    warnings: [],
    steps: [{
      kind: "claimCollateral", to: bo, value: 0n,
      data: encodeFunctionData({ abi: borrowerOperationsAbi, functionName: "claimCollateral", args: [] }),
      describe: "Claim collateral surplus",
    }],
    allowedTargets: [bo], executable: true, nativeValue: 0n,
  };
}

/** For display/tests: does the current deployment support live borrow execution? */
export function borrowExecutable(): boolean {
  return NEEDED.every((k) => registry.hasContract(k));
}
export { formatUnits };
