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
import type { TokenInfo } from "../../registry/addresses.js";

/**
 * SwapBuilder — deterministic construction of a DEX swap against the
 * Velodrome-style Router V2. The LLM never reaches here; it only produces a
 * validated intent (from-symbol, to-symbol, amount). This module:
 *   1. resolves addresses from the registry (never invents them),
 *   2. quotes both the stable and volatile pool and picks the better route,
 *   3. computes an on-chain min-out from the slippage tolerance,
 *   4. emits an ordered plan (optional approval → swap) as encoded calldata.
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
  route: Route;
  steps: PlanStep[];
  /** The router — the only target the signer should be allowed to touch here. */
  router: Address;
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
  if (!registry.hasContract("Router") || !registry.hasContract("PoolFactory")) {
    throw new SwapUnavailableError(
      "The DEX Router/PoolFactory address is not yet confirmed for this network. " +
        "Swaps activate once the registry is populated from the canonical reference.",
    );
  }
  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");

  const amountIn = parseUnits(humanAmountIn, tokenIn.decimals);
  if (amountIn <= 0n) throw new SwapUnavailableError("Amount must be greater than zero.");

  // Native <-> token routes need the wrapped-native token as the route endpoint.
  const nativeInvolved = tokenIn.native || tokenOut.native;
  if (nativeInvolved) {
    throw new SwapUnavailableError(
      "Native BTC swaps require the confirmed wrapped-native (WBTC) route endpoint, " +
        "pending registry confirmation. Token↔token swaps (e.g. MUSD↔mUSDC) are available first.",
    );
  }

  // Quote both pool types and keep the better one.
  const best = await bestQuote(amountIn, tokenIn.address, tokenOut.address, factory);
  if (!best) {
    throw new SwapUnavailableError(
      `No liquidity route found for ${tokenIn.symbol} → ${tokenOut.symbol}.`,
    );
  }

  const minOut = applySlippage(best.amountOut, slippagePct);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  const steps: PlanStep[] = [];

  // Approval (token input only) — top up allowance to the router if short.
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
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [router, amountIn],
      }),
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
      args: [amountIn, minOut, [best.route], owner, deadline],
    }),
    value: 0n,
    describe: `Swap ${humanAmountIn} ${tokenIn.symbol} → ~${formatUnits(
      best.amountOut,
      tokenOut.decimals,
    )} ${tokenOut.symbol}`,
  });

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountInFormatted: humanAmountIn,
    expectedOut: best.amountOut,
    expectedOutFormatted: formatUnits(best.amountOut, tokenOut.decimals),
    minOut,
    minOutFormatted: formatUnits(minOut, tokenOut.decimals),
    slippagePct,
    route: best.route,
    steps,
    router,
  };
}

async function bestQuote(
  amountIn: bigint,
  from: Address,
  to: Address,
  factory: Address,
): Promise<{ amountOut: bigint; route: Route } | undefined> {
  const candidates: Route[] = [
    { from, to, stable: true, factory },
    { from, to, stable: false, factory },
  ];

  let best: { amountOut: bigint; route: Route } | undefined;
  for (const route of candidates) {
    try {
      const amounts = (await publicClient().readContract({
        address: registry.contract("Router"),
        abi: routerAbi,
        functionName: "getAmountsOut",
        args: [amountIn, [route]],
      })) as bigint[];
      const out = amounts.at(-1) ?? 0n;
      if (out > 0n && (!best || out > best.amountOut)) {
        best = { amountOut: out, route };
      }
    } catch {
      // Pool of this type may not exist; try the other.
    }
  }
  return best;
}

/** min-out = expected * (1 - slippage). Uses basis points for integer math. */
function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100)); // e.g. 0.5% -> 50
  return (amountOut * (10_000n - bps)) / 10_000n;
}
