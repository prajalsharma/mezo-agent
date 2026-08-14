import { InlineKeyboard, type Context } from "grammy";
import { formatUnits } from "viem";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { registry } from "../../registry/registry.js";
import { buildSwap, SwapUnavailableError, type SwapPlan } from "../../surfaces/swap/swapBuilder.js";
import { executeSwap } from "../../surfaces/swap/swapService.js";
import { simulateCall } from "../../core/simulator.js";
import { setPending, takePending, clearPending, attachCard, refusalText } from "../session.js";
import { limitsOf, fmtBtc } from "../../custody/policy.js";
import { validateIntent, IntentRejected, type SwapIntent } from "../../llm/intent.js";
import { prettyAmount } from "../../portfolio/portfolioService.js";
import { b, i, esc } from "../format.js";
import { preflightBalances, friendlyReason, renderSuccess, actionHashOf, actionLanded } from "./txResult.js";
import { referralFor } from "../../core/referral.js";

const DEFAULT_SLIPPAGE_PCT = 0.5;

export async function handleSwapIntent(ctx: Context, raw: SwapIntent): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }

  // Same choke point as actions: the menu's swapx: callback builds this intent
  // from raw callback-data fragments and a computed preset amount, neither of
  // which the schema had ever seen.
  let intent: SwapIntent;
  try {
    intent = validateIntent(raw) as SwapIntent;
  } catch (err) {
    if (err instanceof IntentRejected) {
      await ctx.reply(`⚠️ ${esc(err.message)}`, { parse_mode: "HTML" });
      return;
    }
    throw err;
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
    // referralFor is the single source of truth (self-referral guard, zero-share
    // guard) shared with the zap path and the DCA keeper.
    const referral = await referralFor(telegramId, user.address);
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
      `${b(`Live quote - ${netTag}`)}\n\n${quoteBody}\n\n${i(plan.gatedReason ?? "Execution is not available yet.")}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Balance pre-check BEFORE offering Confirm — for an ERC-20 input the leading
  // step is an approval that would simulate fine even with no balance, masking a
  // doomed swap. This reads the actual input-token balance up front.
  const shortfall = await preflightBalances(user.address, plan);
  if (shortfall) {
    await ctx.reply(`⚠️ ${esc(shortfall)}`, { parse_mode: "HTML" });
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
  // A failed simulation means the tx would revert — don't offer Confirm on a
  // doomed swap; show the friendly reason instead. (Only the leading step is
  // simulatable pre-signing; the balance pre-check above covers the rest.)
  if (!sim.ok) {
    await ctx.reply(`⚠️ This swap can't go through: ${esc(friendlyReason(sim.reason))}`, { parse_mode: "HTML" });
    return;
  }
  const simLine = "✅ Simulated OK";

  // Confirmation step-up: above the per-user native threshold, require a second,
  // explicit high-value confirmation before signing.
  const threshold = BigInt(limitsOf(user.limits).confirmationThresholdNativeWei);
  const nativeValue = plan.nativeValue;
  const requiresStepUp = nativeValue > threshold;

  // The id binds THIS card to THIS plan. It travels in the callback data, so a
  // tap on an older card is recognisable as stale instead of silently executing
  // whatever plan happens to occupy the user's slot.
  const planId = setPending(telegramId, { kind: "swap", plan, stepUpPending: requiresStepUp }, user.address);

  const needsApproval = plan.steps.some((s) => s.kind === "approval");
  const kb = new InlineKeyboard().text("✅ Confirm", `swap:confirm:${planId}`).text("✖️ Cancel", `swap:cancel:${planId}`);

  const sent = await ctx.reply(
    `${b(`Confirm swap - ${netTag}`)}\n\n` +
      `${quoteBody}\n` +
      (needsApproval ? `Steps: approve → swap\n` : `Steps: swap\n`) +
      `\n${esc(simLine)}\n\n` +
      (requiresStepUp
        ? `⚠️ ${b("High-value action")}: moves ${esc(fmtBtc(nativeValue))} (over your ${esc(fmtBtc(threshold))} step-up threshold). You'll confirm once more.\n\n`
        : "") +
      i("This preview expires in 3 minutes."),
    { parse_mode: "HTML", reply_markup: kb },
  );
  attachCard(telegramId, planId, sent.chat.id, sent.message_id);
}

export async function handleSwapConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Claim the plan FIRST, before any await. Everything after an await is racing
  // a second tap: grammY dispatches same-user updates concurrently, so two rapid
  // confirms both used to read the plan before either cleared it and execute the
  // swap twice against one confirmation.
  const id = callbackId(ctx);
  const taken = takePending(telegramId, id, getUser(telegramId)?.address);
  await ctx.answerCallbackQuery().catch(() => {});
  if (!taken.ok || taken.pending.kind !== "swap") {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(taken.ok ? refusalText("none") : refusalText(taken.why));
    return;
  }
  const pendingState = taken.pending;
  const user = getUser(telegramId);
  if (!user) return;

  // The active account can be switched between the card and the tap. Signing
  // account 2's key over calldata built for account 1 is never what was meant.
  if (pendingState.accountAddress && pendingState.accountAddress.toLowerCase() !== user.address.toLowerCase()) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(
      `You switched active account since that quote was built (it was for ${pendingState.accountAddress}). ` +
        `I didn't execute it — ask again and I'll quote for ${user.address}.`,
    );
    return;
  }

  // Step-up: first Confirm on a high-value action asks for a second confirmation
  // rather than executing immediately. The re-park gets a FRESH id, so the card
  // we just re-armed is the only one that can complete it.
  if (pendingState.stepUpPending) {
    const nextId = setPending(telegramId, { kind: "swap", plan: pendingState.plan, stepUpPending: false }, user.address);
    const kb = new InlineKeyboard()
      .text("✅ Yes, execute", `swap:confirm:${nextId}`)
      .text("✖️ Cancel", `swap:cancel:${nextId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    if (ctx.callbackQuery?.message) {
      attachCard(telegramId, nextId, ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
    }
    await ctx.reply("⚠️ High-value action - tap “Yes, execute” to proceed, or Cancel.");
    return;
  }

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("⏳ Executing…");

  const result = await executeSwap(user, pendingState.plan, async (msg) => {
    await ctx.reply(msg);
  });

  const plan = pendingState.plan;
  const successLines = [
    `Sold ${prettyAmount(formatUnits(plan.amountInNet, plan.tokenIn.decimals))} ${plan.tokenIn.symbol}`,
    `Received ~${prettyAmount(plan.expectedOutFormatted)} ${plan.tokenOut.symbol} (estimated)`,
  ];

  // Ledger the referral reward from what actually settled on-chain, using the
  // referrer id CAPTURED AT BUILD TIME (a confirm-time store re-read could
  // leave an on-chain payout unledgered — audit). Settlement rules:
  //   atomic path — the referral is paid INSIDE the swap step;
  //   legacy path — the referral transfer is its own final "referral" step.
  const rp = plan.referralPaid;
  const referralSettled =
    rp && rp.amount > 0n &&
    result.outcomes.some((o) => o.ok && (plan.steps.some((s) => s.kind === "referral") ? o.kind === "referral" : o.kind === "swap"));
  if (referralSettled) store.recordReferralEarning(rp.referrerTelegramId, rp.symbol, rp.amount);

  if (result.aborted) {
    const failed = result.outcomes.find((o) => !o.ok);
    // Swap confirmed on-chain but only a trailing payout step failed → the user
    // got their swap; report success with an accurate note, not "aborted".
    if (failed && !failed.ok && (failed.kind === "fee" || failed.kind === "referral") && actionLanded(result.outcomes)) {
      const hash = actionHashOf(result.outcomes)!;
      const note = failed.kind === "referral"
        ? `Your swap and the agent fee settled, but the referral payout couldn't be delivered (${friendlyReason(failed.reason)}) - it's logged and owed to your referrer.`
        : `The agent fee couldn't be applied (${friendlyReason(failed.reason)}), but your swap went through.`;
      await ctx.reply(
        renderSuccess({ title: "Swap complete", lines: successLines, hash, network: env.network, note }),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      return;
    }
    const reason = failed && !failed.ok ? friendlyReason(failed.reason) : "unknown error";
    await ctx.reply(`❌ Swap didn't go through: ${esc(reason)}`, { parse_mode: "HTML" });
    return;
  }

  const hash = actionHashOf(result.outcomes) ?? result.finalHash!;
  await ctx.reply(
    renderSuccess({ title: "Swap complete", lines: successLines, hash, network: env.network }),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleSwapCancel(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  // Consume by id, so cancelling a STALE card cannot disarm the live plan the
  // user is actually looking at.
  const taken = takePending(telegramId, callbackId(ctx), getUser(telegramId)?.address);
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(taken.ok ? "Swap cancelled. Nothing was signed." : "That card was already replaced or expired - nothing was signed.");
}

/** The plan id a confirm/cancel button carries, e.g. "swap:confirm:<id>". */
export function callbackId(ctx: Context): string {
  return (ctx.callbackQuery?.data ?? "").split(":")[2] ?? "";
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
