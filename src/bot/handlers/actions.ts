import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { buildActionPlan, ActionUnavailableError } from "../../surfaces/dispatch.js";
import { executeActionPlan, type ActionPlan } from "../../surfaces/plan.js";
import { simulateCall } from "../../core/simulator.js";
import { limitsOf, fmtBtc } from "../../custody/policy.js";
import { setPending, takePending, clearPending, attachCard, refusalText } from "../session.js";
import { callbackId } from "./swap.js";
import { validateIntent, IntentRejected, type Intent } from "../../llm/intent.js";
import { b, i, esc } from "../format.js";
import { preflightBalances, friendlyReason, renderSuccess, actionHashOf, actionLanded } from "./txResult.js";
import { referralFor } from "../../core/referral.js";
import { store } from "../../db/store.js";

/**
 * Generic handler for every fund-moving surface (borrow, lock, vote, zap, …).
 * Renders the ActionPlan the same way for all of them — title, human summary,
 * risk warnings, per-step list — then either a Confirm/Cancel keyboard (when the
 * plan is executable) or a preview note (when it's gated). One code path, so the
 * confirmation UX and safety are identical everywhere.
 */

function renderPlan(plan: ActionPlan): string {
  const lines = [b(plan.title), ""];
  for (const s of plan.summary) lines.push("• " + esc(s));
  if (plan.warnings.length) {
    lines.push("");
    for (const w of plan.warnings) lines.push("⚠️ " + esc(w));
  }
  if (plan.steps.length > 1) {
    lines.push("", esc(`Steps: ${plan.steps.map((s) => s.kind).join(" → ")}`));
  }
  return lines.join("\n");
}

export async function handleActionIntent(ctx: Context, raw: Intent): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return true;
  }

  // Validate HERE, not at the call sites. Inline-keyboard callbacks reach this
  // function with fragments string-split out of raw callback data, which used to
  // skip the schema entirely — including the amount regex that is the codebase's
  // strongest guard against parse divergence.
  let intent: Intent;
  try {
    intent = validateIntent(raw);
  } catch (err) {
    if (err instanceof IntentRejected) {
      await ctx.reply(`⚠️ ${esc(err.message)}`, { parse_mode: "HTML" });
      return true;
    }
    throw err;
  }

  let plan: ActionPlan | undefined;
  try {
    // Referral context (zap fee split + referred discount) — same resolver as swaps.
    plan = await buildActionPlan(intent, user.address, await referralFor(telegramId, user.address));
  } catch (err) {
    if (err instanceof ActionUnavailableError) {
      await ctx.reply(`⚠️ ${esc(err.message)}`, { parse_mode: "HTML" });
      return true;
    }
    throw err; // surfaced by the global error boundary
  }
  if (!plan) return false; // not an action this handler owns

  // Remember the pool so the natural follow-up works. The bot ends a zap by
  // telling the user to stake, so "now stake it" must resolve to that pool
  // instead of reprinting the token list.
  if ("pool" in intent && typeof intent.pool === "string" && intent.pool) {
    store.setLastPool(telegramId, intent.pool.toUpperCase());
  }

  const netTag = env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet";

  // Gated (preview-only) plan: show the summary, no signing.
  if (!plan.executable) {
    await ctx.reply(
      `${renderPlan(plan)}\n\n${i(plan.gatedReason ?? "Execution isn't available on this deployment yet.")}`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  // Balance pre-check BEFORE offering Confirm — catches insufficient funds up
  // front, so the user never signs an approval that spends gas only to hit an
  // abort on the spend step.
  const shortfall = await preflightBalances(user.address, plan);
  if (shortfall) {
    await ctx.reply(`⚠️ ${esc(shortfall)}`, { parse_mode: "HTML" });
    return true;
  }

  // Preview-simulate the FIRST step. For single-step actions whose primary call
  // is step 0 (notably borrow's openTrove), this surfaces a protocol revert like
  // "ICR < MCR" as a plain sentence BEFORE the user signs, instead of after. For
  // approval-first plans the approval simulates fine and the real check happens
  // per-step at execution — same as the swap flow.
  const first = plan.steps[0]!;
  const sim = await simulateCall({ from: user.address, to: first.to, data: first.data, value: first.value });
  if (!sim.ok) {
    await ctx.reply(`⚠️ This can't go through: ${esc(friendlyReason(sim.reason))}`, { parse_mode: "HTML" });
    return true;
  }

  const threshold = BigInt(limitsOf(user.limits).confirmationThresholdNativeWei);
  const requiresStepUp = plan.nativeValue > threshold;
  // The id binds THIS card to THIS plan — see src/bot/session.ts.
  const planId = setPending(telegramId, { kind: "action", plan, stepUpPending: requiresStepUp }, user.address);

  const kb = new InlineKeyboard().text("✅ Confirm", `action:confirm:${planId}`).text("✖️ Cancel", `action:cancel:${planId}`);
  const sent = await ctx.reply(
    `${renderPlan(plan)}\n\n${b(netTag)}\n` +
      (requiresStepUp
        ? `⚠️ ${b("High-value")}: moves ${esc(fmtBtc(plan.nativeValue))} (over your ${esc(fmtBtc(threshold))} step-up threshold). You'll confirm once more.\n`
        : "") +
      i("Confirm to simulate-then-sign each step, or Cancel. Expires in 3 minutes."),
    { parse_mode: "HTML", reply_markup: kb },
  );
  attachCard(telegramId, planId, sent.chat.id, sent.message_id);
  return true;
}

export async function handleActionConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  // Claim the plan BEFORE any await — see handleSwapConfirm for why the gap
  // between "read" and "clear" was a double-execution race.
  const taken = takePending(telegramId, callbackId(ctx), getUser(telegramId)?.address);
  await ctx.answerCallbackQuery().catch(() => {});
  if (!taken.ok || taken.pending.kind !== "action") {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(taken.ok ? refusalText("none") : refusalText(taken.why));
    return;
  }
  const pending = taken.pending;
  const user = getUser(telegramId);
  if (!user) return;

  // Active-account switch between render and confirm would sign account 2's key
  // over calldata built for account 1.
  if (pending.accountAddress && pending.accountAddress.toLowerCase() !== user.address.toLowerCase()) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(
      `You switched active account since that plan was built (it was for ${pending.accountAddress}). ` +
        `I didn't execute it — ask again and I'll build it for ${user.address}.`,
    );
    return;
  }

  if (pending.stepUpPending) {
    const nextId = setPending(telegramId, { kind: "action", plan: pending.plan, stepUpPending: false }, user.address);
    const kb = new InlineKeyboard().text("✅ Yes, execute", `action:confirm:${nextId}`).text("✖️ Cancel", `action:cancel:${nextId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    if (ctx.callbackQuery?.message) {
      attachCard(telegramId, nextId, ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
    }
    await ctx.reply("⚠️ High-value action - tap “Yes, execute” to proceed, or Cancel.");
    return;
  }

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("⏳ Executing…");

  const result = await executeActionPlan(user, pending.plan, async (msg) => { await ctx.reply(msg); });

  // Ledger the referral cut when it actually settled on-chain: for atomic zaps
  // the split happens INSIDE the swap step, so a confirmed swap step == paid.
  const rp = pending.plan.referralPaid;
  if (rp && rp.amount > 0n && result.outcomes.some((o) => o.ok && o.kind === "swap")) {
    store.recordReferralEarning(rp.referrerTelegramId, rp.symbol, rp.amount);
  }

  if (result.aborted) {
    const failed = result.outcomes.find((o) => !o.ok);
    // If the real action landed and only the trailing agent fee failed, the user
    // DID get what they asked for — report success with a note, not "Aborted".
    if (failed && !failed.ok && failed.kind === "fee" && actionLanded(result.outcomes)) {
      const hash = actionHashOf(result.outcomes)!;
      await ctx.reply(
        renderSuccess({
          title: pending.plan.title,
          lines: pending.plan.summary,
          hash,
          network: env.network,
          note: `The agent fee couldn't be applied (${friendlyReason(failed.reason)}), but your action went through.`,
        }),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      return;
    }
    const reason = failed && !failed.ok ? friendlyReason(failed.reason) : "unknown error";
    await ctx.reply(`❌ Couldn't complete that: ${esc(reason)}`, { parse_mode: "HTML" });
    return;
  }

  const hash = actionHashOf(result.outcomes) ?? result.finalHash!;
  await ctx.reply(
    renderSuccess({ title: pending.plan.title, lines: pending.plan.summary, hash, network: env.network }),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleActionCancel(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  // By id, so cancelling a stale card can't disarm the live plan.
  const taken = takePending(telegramId, callbackId(ctx), getUser(telegramId)?.address);
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(taken.ok ? "Cancelled. Nothing was signed." : "That card was already replaced or expired - nothing was signed.");
}
