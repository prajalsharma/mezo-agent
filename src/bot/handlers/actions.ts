import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { buildActionPlan, ActionUnavailableError } from "../../surfaces/dispatch.js";
import { executeActionPlan, type ActionPlan } from "../../surfaces/plan.js";
import { limitsOf, fmtBtc } from "../../custody/policy.js";
import { setPending, getPending, clearPending } from "../session.js";
import type { Intent } from "../../llm/intent.js";
import { b, i, esc } from "../format.js";
import { preflightBalances, friendlyReason, renderSuccess, actionHashOf, actionLanded } from "./txResult.js";

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

export async function handleActionIntent(ctx: Context, intent: Intent): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return true;
  }

  let plan: ActionPlan | undefined;
  try {
    plan = await buildActionPlan(intent, user.address);
  } catch (err) {
    if (err instanceof ActionUnavailableError) {
      await ctx.reply(`⚠️ ${esc(err.message)}`, { parse_mode: "HTML" });
      return true;
    }
    throw err; // surfaced by the global error boundary
  }
  if (!plan) return false; // not an action this handler owns

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

  const threshold = BigInt(limitsOf(user.limits).confirmationThresholdNativeWei);
  const requiresStepUp = plan.nativeValue > threshold;
  setPending(telegramId, { kind: "action", plan, stepUpPending: requiresStepUp });

  const kb = new InlineKeyboard().text("✅ Confirm", "action:confirm").text("✖️ Cancel", "action:cancel");
  await ctx.reply(
    `${renderPlan(plan)}\n\n${b(netTag)}\n` +
      (requiresStepUp
        ? `⚠️ ${b("High-value")}: moves ${esc(fmtBtc(plan.nativeValue))} (over your ${esc(fmtBtc(threshold))} step-up threshold). You'll confirm once more.\n`
        : "") +
      i("Confirm to simulate-then-sign each step, or Cancel. Expires in 3 minutes."),
    { parse_mode: "HTML", reply_markup: kb },
  );
  return true;
}

export async function handleActionConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const pending = getPending(telegramId);
  if (!pending || pending.kind !== "action") {
    await ctx.reply("That preview expired. Please request the action again.");
    return;
  }
  const user = getUser(telegramId);
  if (!user) return;

  if (pending.stepUpPending) {
    setPending(telegramId, { kind: "action", plan: pending.plan, stepUpPending: false });
    const kb = new InlineKeyboard().text("✅ Yes, execute", "action:confirm").text("✖️ Cancel", "action:cancel");
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    await ctx.reply("⚠️ High-value action — tap “Yes, execute” to proceed, or Cancel.");
    return;
  }

  clearPending(telegramId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("⏳ Executing…");

  const result = await executeActionPlan(user, pending.plan, async (msg) => { await ctx.reply(msg); });

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
          note: "The agent fee couldn't be applied, but your action went through.",
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
  await ctx.answerCallbackQuery().catch(() => {});
  clearPending(telegramId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Cancelled. Nothing was signed.");
}
