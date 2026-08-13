import { type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { borrowerOperationsAbi, troveManagerAbi } from "../abis/mezo.js";
import { log, errMsg } from "../core/log.js";

/**
 * The protocol's own numbers, read from the protocol.
 *
 * Every one of these used to be a compile-time constant in the borrow surface,
 * and the constants had drifted from the deployed contracts:
 *
 *   • the borrowing fee was hardcoded at 1% while the live rate is 0.1% - a 10x
 *     error, and governance can move it again tomorrow,
 *   • MUSD_GAS_COMPENSATION (200 MUSD) was omitted from the debt entirely, even
 *     though openTrove gates on `_getCompositeDebt(netDebt) = netDebt + 200e18`,
 *   • Recovery Mode was unmodeled, so a Trove the protocol judges against CCR
 *     (150%) was being approved at MCR (110%).
 *
 * The two arithmetic errors partially cancelled: below ~22,222 MUSD of debt the
 * agent UNDERSTATED the debt, so it showed "110% healthy" for a Trove that was
 * really at 99% and would revert - and the liquidation warning was up to 10%
 * optimistic, in the direction that gets people liquidated. Above that crossover
 * the missing gas compensation was masked by the inflated fee. That is why the
 * fee and the gas compensation had to be fixed in the same change: correcting
 * only the fee would have removed the accidental protection on large Troves.
 *
 * Reads FAIL CLOSED. A caller that cannot get these numbers must refuse to build
 * a plan rather than fall back to a guess - a guess is what caused the problem.
 */

export type MusdParams = {
  /** Flat MUSD added to every Trove's debt as liquidation gas compensation. */
  gasCompensation: bigint;
  /** One-off borrowing fee, 1e18-scaled (1e15 = 0.1%). Governance-mutable. */
  borrowingRate: bigint;
  /** Minimum NET debt (excludes gas compensation), 1e18-scaled. */
  minNetDebt: bigint;
  /** Minimum individual collateral ratio, 1e18-scaled (1.1e18 = 110%). */
  mcr: bigint;
  /** Critical system collateral ratio, 1e18-scaled (1.5e18 = 150%). */
  ccr: bigint;
};

const WAD = 10n ** 18n;
/** Params are governance-mutable but not per-block; a short cache is honest. */
const TTL_MS = 60_000;

let cache: { at: number; params: MusdParams } | undefined;

/** Live protocol parameters, or undefined if any of them is unreadable. */
export async function musdParams(): Promise<MusdParams | undefined> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.params;
  if (!registry.hasContract("BorrowerOperations")) return undefined;
  const bo = registry.contract("BorrowerOperations");
  try {
    const read = (name: string) =>
      publicClient().readContract({
        address: bo,
        abi: borrowerOperationsAbi,
        functionName: name as never,
      }) as Promise<bigint>;
    const [gasCompensation, borrowingRate, minNetDebt, mcr, ccr] = await Promise.all([
      read("MUSD_GAS_COMPENSATION"),
      read("borrowingRate"),
      read("minNetDebt"),
      read("MCR"),
      read("CCR"),
    ]);
    // A zero here means the read decoded something that is not the parameter we
    // asked for. Treat it as unreadable rather than as "no fee, no minimum".
    if (gasCompensation <= 0n || minNetDebt <= 0n || mcr <= 0n || ccr <= 0n) return undefined;
    const params = { gasCompensation, borrowingRate, minNetDebt, mcr, ccr };
    cache = { at: Date.now(), params };
    return params;
  } catch (e) {
    log.warn("musd.params-unreadable", { error: errMsg(e) });
    return undefined;
  }
}

/** Test seam - drops the cached read. */
export function resetMusdParams(): void {
  cache = undefined;
}

/**
 * Is the system in Recovery Mode at `priceWad`?
 *
 * It changes two rules at once: opens are gated on CCR (150%) instead of MCR
 * (110%), and no borrowing fee is charged. Unmodeled, the agent would approve a
 * ~110% Trove that the protocol rejects at 150%.
 *
 * Returns undefined when unreadable - callers must not assume "normal".
 */
export async function recoveryMode(priceWad: bigint): Promise<boolean | undefined> {
  if (!registry.hasContract("TroveManager")) return undefined;
  try {
    return (await publicClient().readContract({
      address: registry.contract("TroveManager"),
      abi: troveManagerAbi,
      functionName: "checkRecoveryMode",
      args: [priceWad],
    })) as boolean;
  } catch (e) {
    log.warn("musd.recovery-mode-unreadable", { error: errMsg(e) });
    return undefined;
  }
}

/** Total collateral ratio of the whole system at `priceWad`, 1e18-scaled. */
export async function systemTCR(priceWad: bigint): Promise<bigint | undefined> {
  if (!registry.hasContract("TroveManager")) return undefined;
  try {
    return (await publicClient().readContract({
      address: registry.contract("TroveManager"),
      abi: troveManagerAbi,
      functionName: "getTCR",
      args: [priceWad],
    })) as bigint;
  } catch {
    return undefined;
  }
}

/**
 * The Trove's borrowing cap - a STICKY HIGH-WATER MARK stamped at open time as
 * `collateral * price / MCR`, and never raised afterwards.
 *
 * This is the finding that made "add more BTC to borrow more" wrong advice. The
 * cap does not rise when BTC appreciates and it does not rise when the borrower
 * adds collateral; only `refinance` re-stamps it, and it only ever ratchets DOWN
 * on a collateral withdrawal. So after BTC doubles, the agent's ICR arithmetic
 * says a mint is comfortably safe while `_requireNewDebtBelowMaxBorrowingCapacity`
 * rejects it - the user signs, pays gas, and gets an opaque revert.
 *
 * Returns undefined when unreadable (no Trove, or an RPC failure).
 */
export async function maxBorrowingCapacity(owner: Address): Promise<bigint | undefined> {
  if (!registry.hasContract("TroveManager")) return undefined;
  try {
    const cap = (await publicClient().readContract({
      address: registry.contract("TroveManager"),
      abi: troveManagerAbi,
      functionName: "getTroveMaxBorrowingCapacity",
      args: [owner],
    })) as bigint;
    return cap;
  } catch {
    return undefined;
  }
}

// ── Debt arithmetic, defined once ────────────────────────────────────────────
//
// Every surface that reasons about a Trove now shares these, so the borrow card,
// the liquidation warning, the adjust preview and the close pre-check cannot
// disagree about what "debt" means again.

/** The borrowing fee on a net mint. Zero in Recovery Mode - the protocol waives it. */
export function borrowingFee(netDebt: bigint, p: MusdParams, inRecovery: boolean): bigint {
  if (inRecovery) return 0n;
  return (netDebt * p.borrowingRate) / WAD;
}

/**
 * What the protocol will actually record as this Trove's debt:
 * net mint + borrowing fee + gas compensation. This is the number `openTrove`
 * divides the collateral by, and the number a liquidation is priced against.
 */
export function compositeDebt(netDebt: bigint, p: MusdParams, inRecovery: boolean): bigint {
  return netDebt + borrowingFee(netDebt, p, inRecovery) + p.gasCompensation;
}

/** The ratio the protocol requires for an open: CCR in Recovery Mode, else MCR. */
export function requiredCR(p: MusdParams, inRecovery: boolean): bigint {
  return inRecovery ? p.ccr : p.mcr;
}

/**
 * Largest net mint `collateralWad` can support at `priceWad`, inverting
 * compositeDebt: coll*price / required = m*(1 + rate) + gasComp.
 * Returns 0n when the collateral cannot even cover the gas compensation.
 */
export function maxNetMint(
  collateralWad: bigint,
  priceWad: bigint,
  p: MusdParams,
  inRecovery: boolean,
): bigint {
  const budget = (collateralWad * priceWad) / requiredCR(p, inRecovery);
  if (budget <= p.gasCompensation) return 0n;
  const feeScale = inRecovery ? WAD : WAD + p.borrowingRate;
  return ((budget - p.gasCompensation) * WAD) / feeScale;
}

/** BTC price (1e18-scaled) at which a Trove reaches the liquidation threshold. */
export function liquidationPrice(collateralWad: bigint, debtWad: bigint, p: MusdParams): bigint {
  if (collateralWad <= 0n) return 0n;
  return (p.mcr * debtWad) / collateralWad;
}

/** Individual collateral ratio, 1e18-scaled. Returns 0n for zero debt. */
export function icrOf(collateralWad: bigint, priceWad: bigint, debtWad: bigint): bigint {
  if (debtWad <= 0n) return 0n;
  return (collateralWad * priceWad) / debtWad;
}

/** 1e18-scaled ratio → a percentage string for display, e.g. "148%". */
export function pct(wad: bigint): string {
  return `${(Number(wad) / 1e16).toFixed(0)}%`;
}
