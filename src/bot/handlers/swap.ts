import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { registry } from "../../registry/registry.js";
import { buildSwap, SwapUnavailableError } from "../../surfaces/swap/swapBuilder.js";
import { executeSwap } from "../../surfaces/swap/swapService.js";
import { simulateCall } from "../../core/simulator.js";
import { explorerTxUrl } from "../../chain/networks.js";
import { setPending, getPending, clearPending } from "../session.js";
import type { SwapIntent } from "../../llm/intent.js";
import { prettyAmount } from "../../portfolio/portfolioService.js";
import { b, i, link, esc } from "../format.js";

const DEFAULT_SLIPPAGE_PCT = 0.5;

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
    await ctx.reply(
      `I can only swap known tokens: ${registry.knownTokenSymbols().join(", ")}.`,
    );
    return;
  }

  const slippage = intent.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  let plan;
  try {
    plan = await buildSwap({
      owner: user.address,
      tokenIn,
      tokenOut,
      humanAmountIn: intent.amount,
      slippagePct: slippage,
    });
  } catch (err) {
    if (err instanceof SwapUnavailableError) {
      await ctx.reply(`⚠️ ${err.message}`);
      return;
    }
    await ctx.reply("❌ Couldn't build that swap. Please try again.");
    return;
  }

  // Dry-run the leading step so the preview reflects a real simulation.
  const firstStep = plan.steps[0]!;
  const sim = await simulateCall({
    from: user.address,
    to: firstStep.to,
    data: firstStep.data,
    value: firstStep.value,
  });
  const simLine = sim.ok
    ? "✅ Simulated OK"
    : `⚠️ Simulation warning: ${sim.reason}`;

  setPending(telegramId, { kind: "swap", plan });

  const needsApproval = plan.steps.some((s) => s.kind === "approval");
  const kb = new InlineKeyboard()
    .text("✅ Confirm", "swap:confirm")
    .text("✖️ Cancel", "swap:cancel");

  await ctx.reply(
    `${b(`Confirm swap — ${env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet"}`)}\n\n` +
      `Sell: ${b(`${plan.amountInFormatted} ${plan.tokenIn.symbol}`)}\n` +
      `Receive (est.): ${b(`~${prettyAmount(plan.expectedOutFormatted)} ${plan.tokenOut.symbol}`)}\n` +
      `Min received: ${b(`${prettyAmount(plan.minOutFormatted)} ${plan.tokenOut.symbol}`)} (slippage ${plan.slippagePct}%)\n` +
      `Route: ${plan.route.stable ? "stable" : "volatile"} pool\n` +
      (needsApproval ? `Steps: approve → swap\n` : `Steps: swap\n`) +
      `\n${esc(simLine)}\n\n` +
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
