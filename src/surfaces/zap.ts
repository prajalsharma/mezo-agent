import { feeRouterCaps } from "../chain/feeRouterCaps.js";
import { encodeFunctionData, parseUnits, formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { poolAbi } from "../abis/pool.js";
import { routerAbi, feeRouterAbi } from "../abis/router.js";
import { erc20Abi } from "../abis/erc20.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
import { env, feesEnabled } from "../config/env.js";
import { gatedPlan, ActionUnavailableError, type ActionPlan, type ActionStep } from "./plan.js";
import { MAX_SLIPPAGE_PCT, type ZapIntent } from "../llm/intent.js";
import { btcPriceUsd } from "../core/prices.js";
import type { TokenInfo } from "../registry/addresses.js";

/**
 * Zap-to-enter. Given a single asset and a target pool, compute the swaps needed
 * to enter in the right ratio and (optionally) stake the LP. For a balanced
 * pool, ~half the input is swapped to the other side; the split is sized with a
 * LIVE pool quote so the preview is real. Executes swap → addLiquidity through
 * the Router (native BTC via its ERC-20 precompile); staking the resulting LP
 * is its own confirmed action since the LP amount is only known post-deposit.
 */
export async function buildZap(
  intent: ZapIntent,
  owner: import("viem").Address,
  referral?: { recipient: import("viem").Address; sharePct: number; referrerTelegramId: number },
): Promise<ActionPlan> {
  let input = registry.tryToken(intent.inputToken);
  if (!input) throw new ActionUnavailableError(`Unknown token "${intent.inputToken}".`);
  if (Number(intent.inputAmount) <= 0) throw new ActionUnavailableError("Amount must be greater than zero.");

  const p = registry.resolvePool(...(intent.pool.split("/") as [string, string]));
  if (!p) {
    const avail = registry.pools().map((x) => x.pair.join("/")).join(", ") || "none";
    throw new ActionUnavailableError(`Unknown pool "${intent.pool}". Available: ${avail}.`);
  }

  const [symA, symB] = p.pair;
  let inSym = input.symbol;
  const isMemberOfPool = [symA.toLowerCase(), symB.toLowerCase()].includes(inSym.toLowerCase());
  if (!isMemberOfPool) {
    return gatedPlan({
      action: "zap", title: "⚡ Zap into pool",
      summary: [`Zapping ${intent.inputAmount} ${inSym} into ${p.pair.join("/")} needs a multi-hop route (input isn't a pool token).`],
      reason: "Multi-hop zap routing (input token outside the pool pair) isn't implemented yet - zap with one of the pool's own tokens, or swap first.",
    });
  }

  let otherSym = inSym.toLowerCase() === symA.toLowerCase() ? symB : symA;
  let other = registry.token(otherSym);

  // Can this wallet actually FUND the plan? Approving a token you hold none of
  // still succeeds, so without this the zap submitted two approvals and only
  // then died on transferFrom with an opaque TransferFailed() - the user paid
  // gas twice to be told "the transaction reverted on-chain".
  //
  // A bare "$50 into the BTC/MUSD pool" names no input token, so the parser
  // picks the stable leg on the $1-is-1-MUSD reading. If the wallet holds none
  // of that leg but does hold the other one, use the other: it is the same
  // request, funded. The swap is shown on the confirmation card either way, so
  // this resolves the ambiguity rather than hiding it.
  let switched = false;
  // The amount actually zapped, in the FINAL input token's decimals. After a
  // switch this must be the converted value, never the raw literal: "$50" of
  // BTC is ~0.0006 BTC, and parsing "50" in BTC decimals would try to zap 50
  // BTC.
  let effectiveRaw = parseUnits(intent.inputAmount, input.decimals);
  const needed = effectiveRaw;
  const held = await balanceOf(input, owner);
  if (held < needed) {
    const alt = registry.token(otherSym);
    const altHeld = await balanceOf(alt, owner);
    const altNeeded = await equivalentAmount(input, needed, alt);
    if (altNeeded !== undefined && altHeld >= altNeeded) {
      other = input;
      otherSym = input.symbol;
      input = alt;
      inSym = alt.symbol;
      effectiveRaw = altNeeded;
      switched = true;
    } else {
      throw new ActionUnavailableError(
        `Not enough ${inSym} to zap: you have ${formatUnits(held, input.decimals)} ${inSym}, ` +
          `this needs ${intent.inputAmount}. You hold ${formatUnits(altHeld, alt.decimals)} ${alt.symbol}` +
          (altNeeded === undefined ? "." : `, which is also short of the ~${formatUnits(altNeeded, alt.decimals)} ${alt.symbol} required.`) +
          ` Fund the wallet or try a smaller amount.`,
      );
    }
  }

  // Agent fee on zaps (bounty: "a small fee on swaps/zaps").
  //
  // ATOMIC MODE (FeeRouter configured): the swap leg runs through the FeeRouter
  // with a 2×bps per-call override — 2×bps on HALF the input == the configured
  // bps on the GROSS input, exactly — so the whole zap fee is collected inside
  // the swap-leg transaction. No separate fee tx to fail; a reverted swap leg
  // charges nothing. (Trade-off vs the legacy fee-last ordering: if a LATER leg
  // (addLiquidity) fails after the swap leg landed, the fee was still taken —
  // but the user also holds the swapped tokens, and the executor halts there.)
  //
  // LEGACY MODE: fee deducted up front from the input and charged as the LAST
  // step after the zap lands (with retry + owed-ledger).
  const grossInput = effectiveRaw;
  const humanIn = formatUnits(grossInput, input.decimals);
  // `caps.zapLeg` is part of the condition: without the dedicated entrypoint the
  // only way to charge a zap's full fee atomically was to send an explicit 2x
  // override through swapWithFee — an off-chain number with nothing
  // synchronising it to the on-chain rate, checked against a band that can be a
  // single point. A 1 bps drift reverted the swap leg AFTER both approvals were
  // mined, stranding live allowances. An older router now takes the legacy path
  // instead, where the fee is its own step and no override is sent at all.
  const caps = await feeRouterCaps();
  const atomicFee = feesEnabled && env.fees.swapBps > 0 && registry.hasContract("FeeRouter") && caps.zapLeg;
  // Referred users get the SAME lifetime discount on zaps as on swaps (audit:
  // zaps previously charged the full headline rate and paid referrers nothing).
  const effBps = referral ? env.fees.referredBps : env.fees.swapBps;
  // Send 0 and let the CONTRACT pick the rate: zapLegWithFee doubles the base
  // itself. Passing our own doubled belief hard-reverted FeeTooHigh whenever the
  // chain disagreed about referrer status (we sent 2x the DISCOUNTED rate, 180,
  // against a floor of 2x the FULL rate, 200) - and it reverted on the swap leg,
  // after both approval steps had already been mined, stranding live allowances
  // (audit). swapBuilder already passes 0 for exactly this reason.
  // Use the dedicated zap entrypoint only if the DEPLOYED router has it. On an
  // older router, fall back to swapWithFee and supply the doubled rate as an
  // override, which is what that contract expects. Calling a function the live
  // bytecode lacks just reverts, after the approval has already been mined.
  // Always the dedicated entrypoint, always override 0 — the CONTRACT picks the
  // rate. atomicFee is false unless caps.zapLeg is true, so this is only ever
  // reached on a router that has it.
  const zapLegFn = "zapLegWithFee" as const;
  // What the contract will actually charge on the half it swaps, for quote and
  // minOut math only. Must mirror FeeRouter._takeFee's doubling, or the quote
  // understates the fee and minOut is set too high.
  const chargedBpsOnHalf = atomicFee ? Math.min(effBps * 2, 200) : 0;
  const zapFee = feesEnabled ? (grossInput * BigInt(effBps)) / 10_000n : 0n;
  const inputNet = atomicFee ? grossInput : grossInput - zapFee;
  if (inputNet <= 0n || (atomicFee && zapFee >= grossInput / 2n)) {
    throw new ActionUnavailableError("Amount is too small to cover the agent fee.");
  }
  const half = inputNet / 2n;
  // In atomic mode the FeeRouter takes the fee out of the swap leg, so the
  // amount actually reaching the pool is half - fee.
  const swapLegNet = atomicFee ? half - (half * BigInt(chargedBpsOnHalf)) / 10_000n : half;

  // Live quote for what actually reaches the pool on the swap leg.
  let otherOut = 0n;
  try {
    otherOut = (await publicClient().readContract({
      address: p.address, abi: poolAbi, functionName: "getAmountOut",
      args: [swapLegNet, registry.routingAddress(input)],
    })) as bigint;
  } catch {
    /* pool read may be unavailable off-mainnet; summary still shows the split */
  }

  const summary = [
    ...(switched
      ? [`Using ${inSym} - you hold no ${intent.inputToken.toUpperCase()}, and this is the same request funded from what you have.`]
      : []),
    `Zap ${humanIn} ${inSym} into ${p.pair.join("/")} (${p.stable ? "stable" : "volatile"}):`,
    ...(zapFee > 0n
      ? [`• Agent fee: ${formatUnits(zapFee, input.decimals)} ${inSym} (${effBps / 100}%)${atomicFee ? " - collected atomically in the swap leg" : ""}`]
      : []),
    `• Keep ~${formatUnits(half, input.decimals)} ${inSym}`,
    `• Swap ~${formatUnits(half, input.decimals)} ${inSym} → ${otherOut > 0n ? "~" + Number(formatUnits(otherOut, other.decimals)).toFixed(4) : ""} ${otherSym}`,
    `• Add both as liquidity.`,
  ];
  if (intent.stake) {
    summary.push(`Then: say "stake LP ${p.pair.join("/")}" - the exact LP amount is only known after the deposit lands, so staking is its own confirmed action.`);
  }

  const routerReady = registry.hasContract("Router") && registry.hasContract("PoolFactory");
  if (!routerReady || otherOut <= 0n) {
    return gatedPlan({
      action: "zap", title: "⚡ Zap into pool", summary,
      reason: !routerReady
        ? "Preview only - the Router address isn't confirmed on this deployment yet."
        : "The pool returned a zero quote (no liquidity for this size), so there is nothing safe to execute.",
    });
  }

  // Honest aggregate exposure (Audit R2): a zap is 4 separate txs, not one
  // atomic action, so the true worst case is the swap-leg slippage (0.5%) + the
  // deposit-ratio tolerance (7%) + price impact, and it can be sandwiched in the
  // guaranteed inter-tx gap. Disclose it plainly rather than the per-leg 0.5%.
  // HONOUR THE USER'S SLIPPAGE. ZapIntent accepts `slippagePct` and this used to
  // ignore it completely, hardcoding 0.5% — so someone widening their tolerance
  // to get a thin-pool zap through was silently given the same floor and watched
  // it revert again with no explanation. The schema caps it at MAX_SLIPPAGE_PCT,
  // so it cannot be widened without bound.
  const slippagePct = Math.min(intent.slippagePct ?? 0.5, MAX_SLIPPAGE_PCT);
  const slipBps = BigInt(Math.round(slippagePct * 100));

  const worstCaseLine =
    `⚠️ Worst-case cost up to ~${(slippagePct + 7).toFixed(1)}% (${slippagePct}% swap slippage + up to 7% deposit-ratio tolerance + pool price impact). ` +
    "This zap is 4 separate transactions and can be front-run between them; use a small size on thin pools.";

  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  // Matched to the 3-minute confirmation TTL plus signing/inclusion headroom.
  // A 20-minute deadline outlives the quote it is meant to protect.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 5 * 60);
  const route = { from: registry.routingAddress(input), to: registry.routingAddress(other), stable: p.stable, factory };

  // Swap-leg slippage floor (the real value protection): 0.5% off the quote.
  const minOther = (otherOut * (10_000n - slipBps)) / 10_000n;

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
  const feeRouter = atomicFee ? registry.contract("FeeRouter") : undefined;
  const swapLegTarget = feeRouter ?? router;
  const steps: ActionStep[] = [
    {
      // The whole BTC input is capped here (btcWeiMoved reads erc20.symbol "BTC"),
      // so the intermediate other-token legs below carry no cap tag — they move
      // funds derived from this already-capped input, not new principal.
      // Atomic mode: the swap leg is pulled by the FeeRouter, the addLiquidity
      // A-side by the Router — so each gets its own `half` approval.
      kind: "approval", to: inAddr, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, feeRouter ? half : half * 2n] }),
      describe: `Approve ${inSym} for the router`,
      erc20: { symbol: inSym, amount: feeRouter ? half : half * 2n, kind: "approval" }, waitForReceipt: true,
    },
    ...(feeRouter
      ? [{
          kind: "approval", to: inAddr, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [feeRouter, half] }),
          describe: `Approve ${inSym} for the fee router`,
          erc20: { symbol: inSym, amount: half, kind: "approval" }, waitForReceipt: true,
        } satisfies ActionStep]
      : []),
    {
      kind: "swap", to: swapLegTarget, value: 0n,
      data: feeRouter
        ? encodeFunctionData({
            // A zap leg pays 2x the plain-swap rate (the fee for BOTH halves is
            // charged on the half that gets swapped). Routing it through the
            // dedicated entrypoint means the contract enforces that doubled
            // floor itself - swapWithFee cannot tell the two apart, so a raw
            // caller could have paid half the intended zap fee (audit).
            abi: feeRouterAbi, functionName: zapLegFn,
            // Referral split at source on the zap fee too (parity with swaps).
            args: [half, minOther, [route], deadline,
              (referral?.recipient ?? ZERO_ADDRESS) as Address,
              referral ? Math.min(Math.round(referral.sharePct), 100) * 100 : 0,
              0],
          })
        : encodeFunctionData({
            abi: routerAbi, functionName: "swapExactTokensForTokens",
            args: [half, minOther, [route], owner, deadline],
          }),
      describe: `Swap ${formatUnits(swapLegNet, input.decimals)} ${inSym} → ~${formatUnits(otherOut, other.decimals)} ${otherSym}` +
        (feeRouter ? ` (incl. agent fee, collected in the same tx)` : ""),
      // This half genuinely LEAVES the wallet. Untagged, it was invisible to
      // btcWeiMoved, so a BTC zap only charged its approvals against the caps.
      erc20: { symbol: inSym, amount: half, kind: "spend" },
      waitForReceipt: true,
    },
    {
      kind: "approval", to: otherAddr, value: 0n,
      // Approve the QUOTED amount as a ceiling; the rebuild below decides what
      // is actually deposited, and it can only ever be less than this.
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, otherOut] }),
      describe: `Approve ${formatUnits(otherOut, other.decimals)} ${otherSym} for the router`,
      erc20: { symbol: otherSym, amount: otherOut, kind: "approval" },
      waitForReceipt: true,
    },
    {
      kind: "addLiquidity", to: router, value: 0n,
      data: encodeFunctionData({
        abi: routerAbi, functionName: "addLiquidity",
        args: [inAddr, otherAddr, p.stable, half, otherOut, amountAMin, amountBMin, owner, deadline],
      }),
      // The second half of the input, deposited as the A side.
      erc20: { symbol: inSym, amount: half, kind: "spend" },
      /**
       * Re-size from what the wallet ACTUALLY holds, immediately before signing.
       *
       * amountBDesired above is the PRE-SWAP quote. The swap leg only guarantees
       * `minOther` (0.5% below it), so whenever the fill came in under the quote
       * the router computed an optimal B larger than the balance and
       * `transferFrom` reverted — with the swap already irreversibly settled and
       * the user's funds stranded halfway through a zap. The 7% amountBMin does
       * not help: the shortfall is in the BALANCE, not in the ratio.
       *
       * Reading the real balance here also stops the opposite waste: when the
       * fill came in ABOVE the quote, the surplus used to be left behind.
       */
      rebuild: async (who) => {
        const held = (await publicClient().readContract({
          address: otherAddr, abi: erc20Abi, functionName: "balanceOf", args: [who],
        })) as bigint;
        const desiredB = held < otherOut ? held : otherOut;
        if (desiredB === 0n) return undefined; // nothing arrived; let it revert loudly
        // Keep the accepted-ratio floor proportional to what we now ask for, so
        // a smaller deposit is not judged against the original quote's floor.
        const minB = (desiredB * LP_MIN_BPS) / 10_000n;
        return encodeFunctionData({
          abi: routerAbi, functionName: "addLiquidity",
          args: [inAddr, otherAddr, p.stable, half, desiredB, amountAMin, minB, who, deadline],
        });
      },
      describe: `Add ~${formatUnits(half, input.decimals)} ${inSym} + up to ~${formatUnits(otherOut, other.decimals)} ${otherSym} as liquidity`,
    },
  ];

  // Legacy mode only — agent fee LAST (Audit R3 F1), charged after the zap
  // lands. In atomic mode the fee was already collected inside the swap leg.
  const feeTargets: Address[] = [];
  if (zapFee > 0n && !atomicFee) {
    const recipient = env.fees.recipient as Address;
    feeTargets.push(input.native ? recipient : inAddr);
    steps.push(
      input.native
        ? { kind: "fee", to: recipient, value: zapFee, describe: `Agent fee ${formatUnits(zapFee, input.decimals)} BTC (${effBps / 100}%)`, waitForReceipt: true }
        : {
            kind: "fee", to: inAddr, value: 0n,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, zapFee] }),
            describe: `Agent fee ${formatUnits(zapFee, input.decimals)} ${inSym} (${effBps / 100}%)`,
            erc20: { symbol: inSym, amount: zapFee }, waitForReceipt: true,
          },
    );
  }

  // Ledger record for the referrer's cut, paid at source inside the swap leg
  // (atomic mode only — the legacy zap path pays no referral split). Amount may
  // differ from on-chain by ≤1 base unit on odd gross inputs (half rounding).
  const referralPaid =
    feeRouter && referral && zapFee > 0n
      ? {
          referrerTelegramId: referral.referrerTelegramId,
          recipient: referral.recipient,
          symbol: inSym,
          amount: (zapFee * BigInt(Math.round(referral.sharePct))) / 100n,
        }
      : undefined;

  return {
    action: "zap", title: "⚡ Zap into pool", summary,
    warnings: [worstCaseLine, p.stable ? "Stable pool: impermanent loss is minimal while both sides hold their peg." : "If the two tokens' prices diverge, your LP can be worth less than just holding them (impermanent loss) - fees and rewards are the compensation.", "Multi-tx zap is not atomic; a failed leg halts the remaining steps and may leave a residual allowance."],
    steps, allowedTargets: [router, inAddr, otherAddr, ...(feeRouter ? [feeRouter] : []), ...feeTargets],
    // Step-up threshold is BTC-denominated: a BTC-input zap moves the full gross input.
    executable: true, nativeValue: input.native ? grossInput : 0n,
    referralPaid,
  };
}

/** Live balance of a registry token, native BTC included. */
async function balanceOf(token: TokenInfo, owner: Address): Promise<bigint> {
  try {
    if (token.native) return await publicClient().getBalance({ address: owner });
    return (await publicClient().readContract({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  } catch {
    return 0n; // unreadable balance must not silently pass the funding gate
  }
}

/**
 * Roughly how much `to` is worth the same as `amount` of `from`, for deciding
 * whether the other pool leg could fund the same request. USD-pegged tokens are
 * treated as $1; BTC uses the live feed. Returns undefined when the pair cannot
 * be priced, in which case the caller must not switch.
 */
async function equivalentAmount(from: TokenInfo, amount: bigint, to: TokenInfo): Promise<bigint | undefined> {
  const usd = async (t: TokenInfo, raw: bigint): Promise<number | undefined> => {
    const human = Number(formatUnits(raw, t.decimals));
    if (/^m?usd/i.test(t.symbol)) return human;
    if (t.symbol.toUpperCase() === "BTC") {
      const p = await btcPriceUsd();
      return p ? human * p : undefined;
    }
    return undefined;
  };
  const value = await usd(from, amount);
  if (value === undefined) return undefined;
  const oneTo = await usd(to, parseUnits("1", to.decimals));
  if (!oneTo) return undefined;
  return parseUnits((value / oneTo).toFixed(Math.min(to.decimals, 8)), to.decimals);
}
