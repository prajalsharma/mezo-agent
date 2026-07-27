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
  kind: "approval" | "swap";
  to: Address;
  data: Hex;
  value: bigint;
  describe: string;
};

export type SwapPlan = {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  amountInFormatted: string;
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
}): Promise<SwapPlan> {
  const { owner, tokenIn, tokenOut, humanAmountIn, slippagePct } = params;

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

  // 1. Live quote straight from the pool reserves (no Router needed).
  const expectedOut = await quoteFromPool(pool, amountIn, tokenIn);
  if (expectedOut <= 0n) {
    throw new SwapUnavailableError(
      `The pool returned a zero quote for ${tokenIn.symbol} → ${tokenOut.symbol} (amount too small or no liquidity).`,
    );
  }
  const minOut = applySlippage(expectedOut, slippagePct);

  const base = {
    tokenIn,
    tokenOut,
    amountIn,
    amountInFormatted: humanAmountIn,
    expectedOut,
    expectedOutFormatted: formatUnits(expectedOut, tokenOut.decimals),
    minOut,
    minOutFormatted: formatUnits(minOut, tokenOut.decimals),
    slippagePct,
    stable: pool.stable,
    poolAddress: pool.address,
  };

  // 2. Execution wiring. Requires a confirmed Router + PoolFactory. Native-BTC
  //    swaps additionally need the confirmed native-swap entrypoint, so they
  //    stay quote-only for now (documented, not hidden).
  const routerReady = registry.hasContract("Router") && registry.hasContract("PoolFactory");
  const nativeInvolved = Boolean(tokenIn.native || tokenOut.native);
  if (!routerReady) {
    return {
      ...base, steps: [], executable: false,
      gatedReason: "Live quote only — the DEX Router address isn't confirmed in the registry yet, so execution is gated. Set it to enable signing.",
    };
  }
  if (nativeInvolved) {
    return {
      ...base, steps: [], executable: false,
      gatedReason: "Live quote only — native-BTC swap execution needs the confirmed native-swap entrypoint. Token↔token swaps execute now.",
    };
  }

  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  const route: Route = { from: tokenIn.address, to: tokenOut.address, stable: pool.stable, factory };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const steps: PlanStep[] = [];

  // Approval — top up allowance to the router if short.
  const allowance = (await publicClient().readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, router],
  })) as bigint;
  if (allowance < amountIn) {
    steps.push({
      kind: "approval",
      to: tokenIn.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, amountIn] }),
      value: 0n,
      describe: `Approve ${humanAmountIn} ${tokenIn.symbol} for the DEX router`,
    });
  }

  steps.push({
    kind: "swap",
    to: router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, minOut, [route], owner, deadline],
    }),
    value: 0n,
    describe: `Swap ${humanAmountIn} ${tokenIn.symbol} → ~${formatUnits(expectedOut, tokenOut.decimals)} ${tokenOut.symbol}`,
  });

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
