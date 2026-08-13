import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "../../chain/client.js";
import { registry } from "../../registry/registry.js";
import type { AssetMove } from "../plan.js";
import { erc20Abi } from "../../abis/erc20.js";
import { routerAbi, feeRouterAbi } from "../../abis/router.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
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
  kind: "approval" | "swap" | "fee" | "referral";
  to: Address;
  /** Absent for a plain native-value transfer (native-BTC agent fee). */
  data?: Hex;
  value: bigint;
  describe: string;
  /** Wait for this step's receipt before the next (approval before spend). */
  waitForReceipt?: boolean;
  /** What this step moves, for the caps. See AssetMove in surfaces/plan.ts. */
  erc20?: AssetMove;
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
  referralPaid?: { recipient: Address; symbol: string; amount: bigint; referrerTelegramId: number };
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

/**
 * On-chain deadline for a swap.
 *
 * Matched to the confirmation TTL (3 minutes, src/bot/session.ts) plus a short
 * allowance for signing and inclusion. It used to be 20 minutes — 6.7x looser
 * than the preview the user actually approved — so a transaction submitted from
 * a stale plan could still execute against a market that had moved, bounded only
 * by the 0.5% slippage. The deadline should not outlive the quote it protects.
 */
const DEADLINE_SECONDS = 5 * 60;

export async function buildSwap(params: {
  owner: Address;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  humanAmountIn: string;
  slippagePct: number;
  /** When the trader was referred, split the fee: sharePct → recipient, rest → operator. */
  referral?: { recipient: Address; sharePct: number; referrerTelegramId: number };
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
  // REFERRED users pay the discounted lifetime rate (the universal bot pattern:
  // 0.9% referred vs 1% headline).
  const effectiveBps = referral ? env.fees.referredBps : env.fees.swapBps;
  const feeAmount = feesEnabled ? (amountIn * BigInt(effectiveBps)) / 10_000n : 0n;
  const amountInNet = amountIn - feeAmount;
  if (amountInNet <= 0n) throw new SwapUnavailableError("Amount is too small to cover the agent fee.");
  const fee: SwapFee | undefined = feeAmount > 0n
    ? {
        bps: effectiveBps,
        amount: feeAmount,
        amountFormatted: formatUnits(feeAmount, tokenIn.decimals),
        recipient: env.fees.recipient as Address,
      }
    : undefined;

  // 1. Live quote straight from the pool reserves (no Router needed), on the
  //    NET amount so the displayed output is what the user actually receives.
  const expectedOut = await quoteFromPool(pool, amountInNet, tokenIn);
  if (expectedOut <= 0n) {
    // Distinguish "pool is EMPTY" (nothing will ever swap; say so and point at
    // funded routes) from "amount too small" — a zero quote alone is ambiguous
    // and users read it as their mistake.
    let emptyPool = false;
    const alternatives: string[] = [];
    try {
      const reservesAbi = [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "_r0", type: "uint256" }, { name: "_r1", type: "uint256" }, { name: "_ts", type: "uint256" }] }] as const;
      const [r0, r1] = (await publicClient().readContract({ address: pool.address, abi: reservesAbi, functionName: "getReserves" })) as unknown as [bigint, bigint, bigint];
      emptyPool = r0 === 0n || r1 === 0n;
      if (emptyPool) {
        for (const p of registry.pools()) {
          if (p.address === pool.address) continue;
          try {
            const [a0, a1] = (await publicClient().readContract({ address: p.address, abi: reservesAbi, functionName: "getReserves" })) as unknown as [bigint, bigint, bigint];
            if (a0 > 0n && a1 > 0n) alternatives.push(`${p.pair[0]} ⇄ ${p.pair[1]}`);
          } catch { /* skip */ }
        }
      }
    } catch { /* fall through to generic message */ }
    throw new SwapUnavailableError(
      emptyPool
        ? `The ${tokenIn.symbol}/${tokenOut.symbol} pool has NO liquidity on ${env.network} yet - no amount can swap there until someone seeds it. ` +
          (alternatives.length ? `Routes that work right now: ${alternatives.join(", ")}.` : "")
        : `The pool returned a zero quote for ${tokenIn.symbol} → ${tokenOut.symbol} (amount too small for the pool's liquidity - try a larger amount).`,
    );
  }
  const minOut = applySlippage(expectedOut, slippagePct);

  const referralPaid =
    fee && referral && referral.sharePct > 0
      ? {
          recipient: referral.recipient,
          symbol: tokenIn.native ? "BTC" : tokenIn.symbol,
          amount: (fee.amount * BigInt(Math.round(referral.sharePct))) / 100n,
          referrerTelegramId: referral.referrerTelegramId,
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
      gatedReason: "Live quote only - the DEX Router address isn't confirmed in the registry yet, so execution is gated. Set it to enable signing.",
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
  const inRouting = route.from;

  // ── ATOMIC PATH: FeeRouter deployed + fee applies ──────────────────────────
  // Swap and fee execute in ONE transaction via the operator's FeeRouter
  // (contracts/src/FeeRouter.sol): a failed swap charges nothing, a successful
  // swap has already collected the fee — revenue can't be lost to a failed
  // follow-up tx. Referral split happens inside the same tx.
  // The env is the single source of truth for the rate: we ALWAYS pass an
  // explicit feeBpsOverride (headline or referred-discount bps), which the
  // contract caps on-chain. A mismatch only ever fails SAFE via minOut.
  if (fee && registry.hasContract("FeeRouter")) {
    const feeRouter = registry.contract("FeeRouter");
    const frAllowance = (await publicClient().readContract({
      address: inRouting, abi: erc20Abi, functionName: "allowance", args: [owner, feeRouter],
    })) as bigint;
    if (frAllowance < amountIn) {
      steps.push({
        kind: "approval", to: inRouting, value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [feeRouter, amountIn] }),
        describe: `Approve ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for the fee router`,
        erc20: { symbol: tokenIn.symbol, amount: amountIn, kind: "approval" },
        waitForReceipt: true,
      });
    }
    const referralShareBps = referral ? Math.min(Math.round(referral.sharePct), 100) * 100 : 0;
    steps.push({
      kind: "swap", to: feeRouter, value: 0n,
      data: encodeFunctionData({
        abi: feeRouterAbi,
        functionName: "swapWithFee",
        // feeBpsOverride = 0: the CONTRACT decides the rate (discounted only for an
        // attested referrer). Passing our own belief could revert when the chain
        // disagrees about referrer status, and would let it drift from the quote.
        args: [amountIn, minOut, [route], deadline, (referral?.recipient ?? ZERO_ADDRESS) as Address, referralShareBps, 0],
      }),
      describe:
        `Swap ${formatUnits(amountInNet, tokenIn.decimals)} ${tokenIn.symbol} → ~${formatUnits(expectedOut, tokenOut.decimals)} ${tokenOut.symbol} ` +
        `(fee ${fee.bps / 100}% collected in the same tx)`,
      erc20: { symbol: tokenIn.symbol, amount: amountIn },
      // WAIT FOR THE RECEIPT. Without this the executor takes its
      // fire-and-forget branch, records the step "ok" on SUBMISSION, and the
      // handler renders "Swap complete" for a transaction that may revert
      // seconds later. The legacy path below always set it; the atomic path —
      // the one that actually runs when a FeeRouter is deployed — did not, so
      // the headline flow was the one reporting success it had not verified.
      // DCA's "🔁 DCA executed" notification inherited the same defect.
      waitForReceipt: true,
    });
    // plan.router doubles as the primary allowlist target for execution.
    return { ...base, steps, executable: true, router: feeRouter };
  }

  // ── LEGACY PATH: approval → swap → fee as separate txs ─────────────────────
  // Step order matters (Audit R3 F1): the fee is charged ONLY AFTER the swap
  // succeeds, so a reverted swap never costs the trader a non-refundable fee.
  // The fee tx itself is retried by the executor and ledgered if it still fails.

  // 1. Approval on the ROUTING address. Native BTC approves through its ERC-20
  // precompile (0x7b7C…0000), which mirrors the native balance.
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

  // 3. Agent fee — AFTER the swap. Splits at source: OPERATOR share first,
  // referrer share LAST (audit: referrer-first meant one failed referral
  // transfer aborted before the operator's cut ever ran — a referral hiccup
  // cost 100% of the fee instead of 30%). The referral step carries its own
  // kind so retries/owed-ledger attribute it to the right beneficiary.
  if (fee) {
    const referrerCut = referral ? (fee.amount * BigInt(Math.round(referral.sharePct))) / 100n : 0n;
    const operatorCut = fee.amount - referrerCut;
    const pushFee = (kind: "fee" | "referral", to: Address, amount: bigint, label: string) => {
      if (amount <= 0n) return;
      steps.push(
        tokenIn.native
          ? { kind, to, data: undefined, value: amount, describe: label }
          : {
              kind, to: tokenIn.address, value: 0n,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
              describe: label, erc20: { symbol: tokenIn.symbol, amount, kind: "spend" },
            },
      );
    };
    const unit = tokenIn.native ? "BTC" : tokenIn.symbol;
    pushFee("fee", fee.recipient, operatorCut, `Agent fee ${formatUnits(operatorCut, tokenIn.decimals)} ${unit} (${fee.bps / 100}%)`);
    if (referrerCut > 0n && referral) {
      pushFee("referral", referral.recipient, referrerCut, `Referral reward ${formatUnits(referrerCut, tokenIn.decimals)} ${unit} → your referrer`);
    }
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
