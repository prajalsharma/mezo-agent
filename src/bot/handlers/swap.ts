import { InlineKeyboard, type Context } from "grammy";
import { formatUnits } from "viem";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { registry } from "../../registry/registry.js";
import { buildSwap, SwapUnavailableError, type SwapPlan } from "../../surfaces/swap/swapBuilder.js";
import { executeSwap } from "../../surfaces/swap/swapService.js";
import { simulateCall } from "../../core/simulator.js";
import { explorerTxUrl } from "../../chain/networks.js";
import { setPending, getPending, clearPending } from "../session.js";
import { limitsOf, fmtBtc } from "../../custody/policy.js";
import type { SwapIntent } from "../../llm/intent.js";
import { prettyAmount } from "../../portfolio/portfolioService.js";
import { b, i, link, esc } from "../format.js";

const DEFAULT_SLIPPAGE_PCT = 0.5;

/** Total native BTC value a plan moves (0 for token↔token swaps). */
function planNativeValue(plan: SwapPlan): bigint {
  return plan.steps.reduce((sum, s) => sum + s.value, 0n);
}

export async function handleSwapIntent(ctx: Context, intent: SwapIntent): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }

  // Resolve tokens via the registry — never from the model's free text.
  const tokenIn = registry.tryToken(intent.fromToken);
  const tokenOut = registry.tryToken(intent.toToken);
  if (!tokenIn || !tokenOut) {
    await ctx.reply(`I can only swap known tokens: ${registry.knownTokenSymbols().join(", ")}.`);
    return;
  }

  const slippage = intent.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  let plan: SwapPlan;
  try {
    // Referral split-at-source: if this trader was referred and a fee is
    // charged, the referrer's share is paid straight to their wallet on-chain.
    const referrerRec = user.referredBy !== undefined ? getUser(user.referredBy) : undefined;
    const referral = referrerRec
      ? { recipient: referrerRec.address, sharePct: env.fees.referralSharePct }
      : undefined;
    plan = await buildSwap({
      owner: user.address,
      tokenIn,
      tokenOut,
      humanAmountIn: intent.amount,
      slippagePct: slippage,
      referral,
    });
  } catch (err) {
    if (err instanceof SwapUnavailableError) {
      await ctx.reply(`⚠️ ${err.message}`);
      return;
    }
    await ctx.reply("❌ Couldn't build that swap. Please try again.");
    return;
  }

  const netTag = env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet";
  const quoteBody =
    `Sell: ${b(`${plan.amountInFormatted} ${plan.tokenIn.symbol}`)}\n` +
    (plan.fee
      ? `Agent fee: ${b(`${prettyAmount(plan.fee.amountFormatted)} ${plan.tokenIn.symbol}`)} (${plan.fee.bps / 100}%)\n` +
        `Swapped: ${b(`${prettyAmount(formatUnits(plan.amountInNet, plan.tokenIn.decimals))} ${plan.tokenIn.symbol}`)}\n`
      : "") +
    `Receive (est.): ${b(`~${prettyAmount(plan.expectedOutFormatted)} ${plan.tokenOut.symbol}`)}\n` +
    `Min received: ${b(`${prettyAmount(plan.minOutFormatted)} ${plan.tokenOut.symbol}`)} (slippage ${plan.slippagePct}%)\n` +
    `Route: ${plan.stable ? "stable" : "volatile"} pool ${esc(short(plan.poolAddress))}`;

  // Quote-only path: show the LIVE quote but do not offer to sign.
  if (!plan.executable) {
    await ctx.reply(
      `${b(`Live quote — ${netTag}`)}\n\n${quoteBody}\n\n${i(plan.gatedReason ?? "Execution is not available yet.")}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Executable path: simulate the leading step so the preview is real.
  const firstStep = plan.steps[0]!;
  const sim = await simulateCall({
    from: user.address,
    to: firstStep.to,
    data: firstStep.data,
    value: firstStep.value,
  });
  const simLine = sim.ok ? "✅ Simulated OK" : `⚠️ Simulation warning: ${sim.reason}`;

  // Confirmation step-up: above the per-user native threshold, require a second,
  // explicit high-value confirmation before signing.
  const threshold = BigInt(limitsOf(user.limits).confirmationThresholdNativeWei);
  const nativeValue = planNativeValue(plan);
  const requiresStepUp = nativeValue > threshold;

  setPending(telegramId, { kind: "swap", plan, stepUpPending: requiresStepUp });

  const needsApproval = plan.steps.some((s) => s.kind === "approval");
  const kb = new InlineKeyboard().text("✅ Confirm", "swap:confirm").text("✖️ Cancel", "swap:cancel");

  await ctx.reply(
    `${b(`Confirm swap — ${netTag}`)}\n\n` +
      `${quoteBody}\n` +
      (needsApproval ? `Steps: approve → swap\n` : `Steps: swap\n`) +
      `\n${esc(simLine)}\n\n` +
      (requiresStepUp
        ? `⚠️ ${b("High-value action")}: moves ${esc(fmtBtc(nativeValue))} (over your ${esc(fmtBtc(threshold))} step-up threshold). You'll confirm once more.\n\n`
        : "") +
      i("This preview expires in 3 minutes."),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function handleSwapConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});

  const pendingState = getPending(telegramId);
  if (!pendingState || pendingState.kind !== "swap") {
    await ctx.reply("That swap preview expired. Please request the swap again.");
    return;
  }
  const user = getUser(telegramId);
  if (!user) return;

  // Step-up: first Confirm on a high-value action asks for a second confirmation
  // rather than executing immediately.
  if (pendingState.stepUpPending) {
    setPending(telegramId, { kind: "swap", plan: pendingState.plan, stepUpPending: false });
    const kb = new InlineKeyboard()
      .text("✅ Yes, execute", "swap:confirm")
      .text("✖️ Cancel", "swap:cancel");
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    await ctx.reply("⚠️ High-value action — tap “Yes, execute” to proceed, or Cancel.");
    return;
  }

  clearPending(telegramId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("⏳ Executing…");

  const result = await executeSwap(user, pendingState.plan, async (msg) => {
    await ctx.reply(msg);
  });

  if (result.aborted) {
    const failed = result.outcomes.find((o) => !o.ok);
    await ctx.reply(`❌ Swap aborted: ${failed && !failed.ok ? failed.reason : "unknown error"}`);
    return;
  }

  // Record the referral reward (paid on-chain in the same tx set) for the
  // referrer's /referral history. Ledger only — settlement already happened.
  const rp = pendingState.plan.referralPaid;
  if (rp && rp.amount > 0n && user.referredBy !== undefined) {
    store.recordReferralEarning(user.referredBy, rp.symbol, rp.amount);
  }

  const hash = result.finalHash!;
  await ctx.reply(
    `✅ ${b("Swap submitted.")}\n${link("View on explorer", explorerTxUrl(env.network, hash))}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleSwapCancel(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});
  clearPending(telegramId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Swap cancelled. Nothing was signed.");
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
