import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "../../chain/client.js";
import { registry } from "../../registry/registry.js";
import { erc20Abi } from "../../abis/erc20.js";
import { routerAbi } from "../../abis/router.js";
import { poolAbi } from "../../abis/pool.js";
import { env, feesEnabled } from "../../config/env.js";
import type { PoolInfo, TokenInfo } from "../../registry/addresses.js";

/**
 * SwapBuilder — deterministic construction of a DEX swap. The LLM never reaches
 * here; it only produces a validated intent (from-symbol, to-symbol, amount).
 *
 * Quoting is done DIRECTLY from the pool's live reserves (`getAmountOut`), so a
 * real quote is available on mainnet with no Router dependency. Execution goes
 * through the Velodrome-style Router V2 when its address is confirmed in the
 * registry; until then the plan is quote-only (`executable = false`) and the
 * handler shows the live quote without offering to sign. Addresses always come
 * from the registry — never invented.
 */

export type Route = {
  from: Address;
  to: Address;
  stable: boolean;
  factory: Address;
};

export type PlanStep = {
  kind: "approval" | "swap" | "fee";
  to: Address;
  /** Absent for a plain native-value transfer (native-BTC agent fee). */
  data?: Hex;
  value: bigint;
  describe: string;
  /** Wait for this step's receipt before the next (approval before spend). */
  waitForReceipt?: boolean;
  /** ERC-20 amount this step moves, for the signer's per-token / BTC cap. */
  erc20?: { symbol: string; amount: bigint };
};

export type SwapFee = {
  bps: number;
  amount: bigint;
  amountFormatted: string;
  recipient: Address;
};

export type SwapPlan = {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  /** Gross amount the user asked to swap (fee inclusive). */
  amountIn: bigint;
  amountInFormatted: string;
  /** Agent fee taken from the input token, or undefined when no fee applies. */
  fee?: SwapFee;
  /** Referral reward split from the fee to the referrer (instant, on-chain). */
  referralPaid?: { recipient: Address; symbol: string; amount: bigint };
  /** BTC value the swap moves (gross), for the handler's high-value step-up. */
  nativeValue: bigint;
  /** Amount actually routed to the DEX after the fee. */
  amountInNet: bigint;
  expectedOut: bigint;
  expectedOutFormatted: string;
  minOut: bigint;
  minOutFormatted: string;
  slippagePct: number;
  stable: boolean;
  poolAddress: Address;
  /** Encoded approval/swap steps — empty when the plan is quote-only. */
  steps: PlanStep[];
  /** True when on-chain execution is wired (Router confirmed & non-native). */
  executable: boolean;
  /** Why execution is gated, when it is. */
  gatedReason?: string;
  /** The router — the only non-token target the signer may touch (if executable). */
  router?: Address;
};

export class SwapUnavailableError extends Error {}

const DEADLINE_SECONDS = 20 * 60;

export async function buildSwap(params: {
  owner: Address;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  humanAmountIn: string;
  slippagePct: number;
  /** When the trader was referred, split the fee: sharePct → recipient, rest → operator. */
  referral?: { recipient: Address; sharePct: number };
}): Promise<SwapPlan> {
  const { owner, tokenIn, tokenOut, humanAmountIn, slippagePct, referral } = params;

  if (tokenIn.symbol === tokenOut.symbol) {
    throw new SwapUnavailableError("Input and output tokens are the same.");
  }

  const pool = registry.resolvePool(tokenIn.symbol, tokenOut.symbol);
  if (!pool) {
    const pairs = registry.pools().map((p) => p.pair.join("/")).join(", ") || "none on this network";
    throw new SwapUnavailableError(
      `No direct pool for ${tokenIn.symbol} → ${tokenOut.symbol}. Available pools: ${pairs}.`,
    );
  }

  const amountIn = parseUnits(humanAmountIn, tokenIn.decimals);
  if (amountIn <= 0n) throw new SwapUnavailableError("Amount must be greater than zero.");

  // Agent fee (monetization) — taken from the INPUT token so the user always
  // sees exactly what is deducted before confirming. Disabled unless configured.
  const feeAmount = feesEnabled ? (amountIn * BigInt(env.fees.swapBps)) / 10_000n : 0n;
  const amountInNet = amountIn - feeAmount;
  if (amountInNet <= 0n) throw new SwapUnavailableError("Amount is too small to cover the agent fee.");
  const fee: SwapFee | undefined = feeAmount > 0n
    ? {
        bps: env.fees.swapBps,
        amount: feeAmount,
        amountFormatted: formatUnits(feeAmount, tokenIn.decimals),
        recipient: env.fees.recipient as Address,
      }
    : undefined;

  // 1. Live quote straight from the pool reserves (no Router needed), on the
  //    NET amount so the displayed output is what the user actually receives.
  const expectedOut = await quoteFromPool(pool, amountInNet, tokenIn);
  if (expectedOut <= 0n) {
    throw new SwapUnavailableError(
      `The pool returned a zero quote for ${tokenIn.symbol} → ${tokenOut.symbol} (amount too small or no liquidity).`,
    );
  }
  const minOut = applySlippage(expectedOut, slippagePct);

  const referralPaid =
    fee && referral && referral.sharePct > 0
      ? {
          recipient: referral.recipient,
          symbol: tokenIn.native ? "BTC" : tokenIn.symbol,
          amount: (fee.amount * BigInt(Math.round(referral.sharePct))) / 100n,
        }
      : undefined;

  const base = {
    tokenIn,
    tokenOut,
    amountIn,
    amountInFormatted: humanAmountIn,
    amountInNet,
    fee,
    referralPaid,
    // BTC value the whole swap moves, for the handler's high-value step-up.
    // Native BTC travels via the precompile with step.value == 0, so summing
    // step.value under-counts to ~0 — carry the true gross amount here so the
    // step-up fires for large BTC swaps (Audit R3 MEDIUM). Token swaps move 0 BTC.
    nativeValue: tokenIn.native ? amountIn : 0n,
    expectedOut,
    expectedOutFormatted: formatUnits(expectedOut, tokenOut.decimals),
    minOut,
    minOutFormatted: formatUnits(minOut, tokenOut.decimals),
    slippagePct,
    stable: pool.stable,
    poolAddress: pool.address,
  };

  // 2. Execution wiring. Requires a confirmed Router + PoolFactory. All three
  //    directions execute: token↔token via swapExactTokensForTokens, and native
  //    BTC via the ETH-named Velodrome entrypoints (ETH == native gas asset).
  const routerReady = registry.hasContract("Router") && registry.hasContract("PoolFactory");
  if (!routerReady) {
    return {
      ...base, steps: [], executable: false,
      gatedReason: "Live quote only — the DEX Router address isn't confirmed in the registry yet, so execution is gated. Set it to enable signing.",
    };
  }
  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  // Routes always use the routing (wrapped-precompile) address: the Router's
  // ETH-named variants move native BTC but still expect the 0x7b7C…0000 token
  // in the Route tuple — passing the zero sentinel produces a dead route.
  const route: Route = {
    from: registry.routingAddress(tokenIn),
    to: registry.routingAddress(tokenOut),
    stable: pool.stable,
    factory,
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const steps: PlanStep[] = [];

  // Step order matters (Audit R3 F1): approval → swap → fee. The fee is charged
  // ONLY AFTER the swap succeeds, so a swap that reverts/aborts never costs the
  // trader a non-refundable fee, and a retry doesn't double-charge. The swap
  // step waits for its receipt when a fee follows, so the fee steps run only on
  // a confirmed swap.

  // 1. Approval on the ROUTING address. Native BTC approves through its ERC-20
  // precompile (0x7b7C…0000), which mirrors the native balance.
  const inRouting = route.from;
  const allowance = (await publicClient().readContract({
    address: inRouting,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, router],
  })) as bigint;
  if (allowance < amountInNet) {
    steps.push({
      kind: "approval",
      to: inRouting,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, amountInNet] }),
      value: 0n,
      describe: `Approve ${formatUnits(amountInNet, tokenIn.decimals)} ${tokenIn.symbol} for the DEX router`,
      waitForReceipt: true,
    });
  }

  // 2. The swap. Spend cap enforced here (the approval may be skipped when an
  // allowance already exists): the swap step carries the erc20 descriptor so the
  // signer prices it — BTC via btcWeiMoved, tokens via the per-token cap.
  steps.push({
    kind: "swap", to: router, value: 0n,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountInNet, minOut, [route], owner, deadline],
    }),
    describe: `Swap ${formatUnits(amountInNet, tokenIn.decimals)} ${tokenIn.symbol} → ~${formatUnits(expectedOut, tokenOut.decimals)} ${tokenOut.symbol}`,
    erc20: { symbol: tokenIn.symbol, amount: amountInNet },
    // Wait for the swap to confirm before charging the fee, so a failed swap
    // never charges a fee. Only needed when a fee actually follows.
    waitForReceipt: fee !== undefined,
  });

  // 3. Agent fee — AFTER the swap. Splits at source: referrer share → referrer
  // wallet, remainder → operator, both shown before signing.
  if (fee) {
    const referrerCut = referral ? (fee.amount * BigInt(Math.round(referral.sharePct))) / 100n : 0n;
    const operatorCut = fee.amount - referrerCut;
    const pushFee = (to: Address, amount: bigint, label: string) => {
      if (amount <= 0n) return;
      steps.push(
        tokenIn.native
          ? { kind: "fee", to, data: undefined, value: amount, describe: label }
          : {
              kind: "fee", to: tokenIn.address, value: 0n,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
              describe: label, erc20: { symbol: tokenIn.symbol, amount },
            },
      );
    };
    const unit = tokenIn.native ? "BTC" : tokenIn.symbol;
    if (referrerCut > 0n && referral) {
      pushFee(referral.recipient, referrerCut, `Referral reward ${formatUnits(referrerCut, tokenIn.decimals)} ${unit} → your referrer`);
    }
    pushFee(fee.recipient, operatorCut, `Agent fee ${formatUnits(operatorCut, tokenIn.decimals)} ${unit} (${fee.bps / 100}%)`);
  }

  return { ...base, steps, executable: true, router };
}

/** Live quote from the pool's own reserves via getAmountOut(amountIn, tokenIn). */
async function quoteFromPool(pool: PoolInfo, amountIn: bigint, tokenIn: TokenInfo): Promise<bigint> {
  const tokenInRouting = registry.routingAddress(tokenIn);
  try {
    return (await publicClient().readContract({
      address: pool.address,
      abi: poolAbi,
      functionName: "getAmountOut",
      args: [amountIn, tokenInRouting],
    })) as bigint;
  } catch (err) {
    throw new SwapUnavailableError(
      `Could not read a quote from the pool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** min-out = expected * (1 - slippage). Uses basis points for integer math. */
function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100)); // e.g. 0.5% -> 50
  return (amountOut * (10_000n - bps)) / 10_000n;
}
