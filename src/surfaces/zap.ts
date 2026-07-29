import { encodeFunctionData, parseUnits, formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { poolAbi } from "../abis/pool.js";
import { routerAbi } from "../abis/router.js";
import { erc20Abi } from "../abis/erc20.js";
import { env, feesEnabled } from "../config/env.js";
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

  // Agent fee on zaps (bounty: "a small fee on swaps/zaps") — taken from the
  // INPUT before the split, disclosed below, charged only AFTER the zap lands.
  const grossInput = parseUnits(intent.inputAmount, input.decimals);
  const zapFee = feesEnabled ? (grossInput * BigInt(env.fees.swapBps)) / 10_000n : 0n;
  const inputNet = grossInput - zapFee;
  if (inputNet <= 0n) throw new ActionUnavailableError("Amount is too small to cover the agent fee.");
  const half = inputNet / 2n;

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
    ...(zapFee > 0n ? [`• Agent fee: ${formatUnits(zapFee, input.decimals)} ${inSym} (${env.fees.swapBps / 100}%)`] : []),
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

  // Honest aggregate exposure (Audit R2): a zap is 4 separate txs, not one
  // atomic action, so the true worst case is the swap-leg slippage (0.5%) + the
  // deposit-ratio tolerance (7%) + price impact, and it can be sandwiched in the
  // guaranteed inter-tx gap. Disclose it plainly rather than the per-leg 0.5%.
  const worstCaseLine =
    "⚠️ Worst-case cost up to ~7.5% (0.5% swap slippage + up to 7% deposit-ratio tolerance + pool price impact). " +
    "This zap is 4 separate transactions and can be front-run between them; use a small size on thin pools.";

  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const route = { from: registry.routingAddress(input), to: registry.routingAddress(other), stable: p.stable, factory };

  // Swap-leg slippage floor (the real value protection): 0.5% off the quote.
  const minOther = (otherOut * 9_950n) / 10_000n;

  // addLiquidity sizing (Audit R2 C2). The swap itself moves the pool price by
  // the fee + our own impact, so at deposit time the pool wants a DIFFERENT
  // ratio than the pre-swap quote. The previous plan set amountAMin to 99.5% of
  // `half` while side B was already discounted, so amountAOptimal (~0.992·half
  // after a 0.3% fee) fell below amountAMin and addLiquidity reverted on EVERY
  // fee-bearing pool — after the swap had irreversibly settled. Fix:
  //   • desire the FULL quoted B (otherOut), so the router can pull the optimal
  //     amount up to what we actually hold;
  //   • set both mins to a wide LP-deposit tolerance (7%) that absorbs the swap
  //     fee + impact — value is already protected on the swap leg's minOther.
  const LP_MIN_BPS = 9_300n; // 7% tolerance on the deposit ratio
  const amountAMin = (half * LP_MIN_BPS) / 10_000n;
  const amountBMin = (otherOut * LP_MIN_BPS) / 10_000n;
  // Everything is ERC-20 on Mezo: native BTC spends through its precompile
  // (route.from is already the routing address), so a single code path covers
  // both native and token inputs — no msg.value, no ETH-variant functions.
  const inAddr = route.from;
  const otherAddr = route.to;
  const steps: ActionStep[] = [
    {
      // The whole BTC input is capped here (btcWeiMoved reads erc20.symbol "BTC"),
      // so the intermediate other-token legs below carry no cap tag — they move
      // funds derived from this already-capped input, not new principal.
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
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, otherOut] }),
      describe: `Approve ${formatUnits(otherOut, other.decimals)} ${otherSym} for the router`,
      waitForReceipt: true,
    },
    {
      kind: "addLiquidity", to: router, value: 0n,
      data: encodeFunctionData({
        abi: routerAbi, functionName: "addLiquidity",
        args: [inAddr, otherAddr, p.stable, half, otherOut, amountAMin, amountBMin, owner, deadline],
      }),
      describe: `Add ~${formatUnits(half, input.decimals)} ${inSym} + ~${formatUnits(otherOut, other.decimals)} ${otherSym} as liquidity`,
    },
  ];

  // Agent fee LAST (like swaps, Audit R3 F1): charged only after the zap lands.
  const feeTargets: Address[] = [];
  if (zapFee > 0n) {
    const recipient = env.fees.recipient as Address;
    feeTargets.push(input.native ? recipient : inAddr);
    steps.push(
      input.native
        ? { kind: "fee", to: recipient, value: zapFee, describe: `Agent fee ${formatUnits(zapFee, input.decimals)} BTC (${env.fees.swapBps / 100}%)`, waitForReceipt: true }
        : {
            kind: "fee", to: inAddr, value: 0n,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, zapFee] }),
            describe: `Agent fee ${formatUnits(zapFee, input.decimals)} ${inSym} (${env.fees.swapBps / 100}%)`,
            erc20: { symbol: inSym, amount: zapFee }, waitForReceipt: true,
          },
    );
  }

  return {
    action: "zap", title: "⚡ Zap into pool", summary,
    warnings: [worstCaseLine, "Multi-tx zap is not atomic; a failed leg halts the remaining steps and may leave a residual allowance."],
    steps, allowedTargets: [router, inAddr, otherAddr, ...feeTargets],
    // Step-up threshold is BTC-denominated: a BTC-input zap moves the full gross input.
    executable: true, nativeValue: input.native ? grossInput : 0n,
  };
}
