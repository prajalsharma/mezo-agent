import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { poolAbi } from "../abis/pool.js";
import { routerAbi } from "../abis/router.js";
import { erc20Abi } from "../abis/erc20.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan, type ActionStep } from "./plan.js";
import type { ZapIntent } from "../llm/intent.js";

/**
 * Zap-to-enter. Given a single asset and a target pool, compute the swaps needed
 * to enter in the right ratio and (optionally) stake the LP. For a balanced
 * pool, ~half the input is swapped to the other side; the split is sized with a
 * LIVE pool quote so the preview is real. Executes swap → addLiquidity through
 * the Router (native BTC via its ERC-20 precompile); staking the resulting LP
 * is its own confirmed action since the LP amount is only known post-deposit.
 */
export async function buildZap(intent: ZapIntent, owner: import("viem").Address): Promise<ActionPlan> {
  const input = registry.tryToken(intent.inputToken);
  if (!input) throw new ActionUnavailableError(`Unknown token "${intent.inputToken}".`);
  if (Number(intent.inputAmount) <= 0) throw new ActionUnavailableError("Amount must be greater than zero.");

  const p = registry.resolvePool(...(intent.pool.split("/") as [string, string]));
  if (!p) {
    const avail = registry.pools().map((x) => x.pair.join("/")).join(", ") || "none";
    throw new ActionUnavailableError(`Unknown pool "${intent.pool}". Available: ${avail}.`);
  }

  const [symA, symB] = p.pair;
  const inSym = input.symbol;
  const isMemberOfPool = [symA.toLowerCase(), symB.toLowerCase()].includes(inSym.toLowerCase());
  if (!isMemberOfPool) {
    return gatedPlan({
      action: "zap", title: "⚡ Zap into pool",
      summary: [`Zapping ${intent.inputAmount} ${inSym} into ${p.pair.join("/")} needs a multi-hop route (input isn't a pool token).`],
      reason: "Multi-hop zap routing (input token outside the pool pair) isn't implemented yet — zap with one of the pool's own tokens, or swap first.",
    });
  }

  const otherSym = inSym.toLowerCase() === symA.toLowerCase() ? symB : symA;
  const other = registry.token(otherSym);
  const half = parseUnits(intent.inputAmount, input.decimals) / 2n;

  // Live quote for the half we swap to the other side.
  let otherOut = 0n;
  try {
    otherOut = (await publicClient().readContract({
      address: p.address, abi: poolAbi, functionName: "getAmountOut",
      args: [half, registry.routingAddress(input)],
    })) as bigint;
  } catch {
    /* pool read may be unavailable off-mainnet; summary still shows the split */
  }

  const summary = [
    `Zap ${intent.inputAmount} ${inSym} into ${p.pair.join("/")} (${p.stable ? "stable" : "volatile"}):`,
    `• Keep ~${formatUnits(half, input.decimals)} ${inSym}`,
    `• Swap ~${formatUnits(half, input.decimals)} ${inSym} → ${otherOut > 0n ? "~" + Number(formatUnits(otherOut, other.decimals)).toFixed(4) : ""} ${otherSym}`,
    `• Add both as liquidity.`,
  ];
  if (intent.stake) {
    summary.push(`Then: say "stake LP ${p.pair.join("/")}" — the exact LP amount is only known after the deposit lands, so staking is its own confirmed action.`);
  }

  const routerReady = registry.hasContract("Router") && registry.hasContract("PoolFactory");
  if (!routerReady || otherOut <= 0n) {
    return gatedPlan({
      action: "zap", title: "⚡ Zap into pool", summary,
      reason: !routerReady
        ? "Preview only — the Router address isn't confirmed on this deployment yet."
        : "The pool returned a zero quote (no liquidity for this size), so there is nothing safe to execute.",
    });
  }

  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const route = { from: registry.routingAddress(input), to: registry.routingAddress(other), stable: p.stable, factory };
  // Received-side floor at 0.5% slippage; also used as the addLiquidity desired
  // amount so the plan never assumes more of the other token than it is
  // guaranteed to hold post-swap (any surplus stays in the wallet as dust).
  const minOther = (otherOut * 9_950n) / 10_000n;
  const minHalf = (half * 9_950n) / 10_000n;
  // Everything is ERC-20 on Mezo: native BTC spends through its precompile
  // (route.from is already the routing address), so a single code path covers
  // both native and token inputs — no msg.value, no ETH-variant functions.
  const inAddr = route.from;
  const otherAddr = route.to;
  const steps: ActionStep[] = [
    {
      kind: "approval", to: inAddr, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, half * 2n] }),
      describe: `Approve ${intent.inputAmount} ${inSym} for the router`,
      erc20: { symbol: inSym, amount: half * 2n }, waitForReceipt: true,
    },
    {
      kind: "swap", to: router, value: 0n,
      data: encodeFunctionData({
        abi: routerAbi, functionName: "swapExactTokensForTokens",
        args: [half, minOther, [route], owner, deadline],
      }),
      describe: `Swap ${formatUnits(half, input.decimals)} ${inSym} → ~${formatUnits(otherOut, other.decimals)} ${otherSym}`,
      waitForReceipt: true,
    },
    {
      kind: "approval", to: otherAddr, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, minOther] }),
      describe: `Approve ${formatUnits(minOther, other.decimals)} ${otherSym} for the router`,
      erc20: { symbol: other.symbol, amount: minOther }, waitForReceipt: true,
    },
    {
      kind: "addLiquidity", to: router, value: 0n,
      data: encodeFunctionData({
        abi: routerAbi, functionName: "addLiquidity",
        args: [inAddr, otherAddr, p.stable, half, minOther, minHalf, (minOther * 9_900n) / 10_000n, owner, deadline],
      }),
      describe: `Add ~${formatUnits(half, input.decimals)} ${inSym} + ~${formatUnits(minOther, other.decimals)} ${otherSym} as liquidity`,
    },
  ];

  return {
    action: "zap", title: "⚡ Zap into pool", summary,
    warnings: ["Each leg enforces a 0.5% slippage floor on-chain; a failed leg halts the remaining steps."],
    steps, allowedTargets: [router, inAddr, otherAddr],
    executable: true, nativeValue: 0n,
  };
}
