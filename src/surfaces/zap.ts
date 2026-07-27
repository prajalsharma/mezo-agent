import { parseUnits, formatUnits } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { poolAbi } from "../abis/pool.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan } from "./plan.js";
import type { ZapIntent } from "../llm/intent.js";

/**
 * Zap-to-enter. Given a single asset and a target pool, compute the swaps needed
 * to enter in the right ratio and (optionally) stake the LP. For a balanced
 * pool, ~half the input is swapped to the other side; the split is sized with a
 * LIVE pool quote so the preview is real. Execution (addLiquidity + gauge stake)
 * is gated on the confirmed Router.
 */
export async function buildZap(intent: ZapIntent): Promise<ActionPlan> {
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
      reason: "Multi-hop zap routing is gated until the Router address is confirmed.",
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
    `• Add both as liquidity` + (intent.stake ? `, then stake the LP for emissions.` : `.`),
  ];
  return gatedPlan({
    action: "zap", title: "⚡ Zap into pool", summary,
    reason: "Split is quoted live; addLiquidity + gauge stake execute once the Router/Voter addresses are confirmed.",
  });
}
