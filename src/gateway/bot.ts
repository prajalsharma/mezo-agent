import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../config.js";
import { Pipeline, type PipelineOutcome } from "../core/pipeline.js";
import { signer } from "../signer/signer.js";
import type { Intent } from "../intents/schema.js";
import type { CallPlan } from "../core/builder.js";

/**
 * Telegram gateway (README §3). Untrusted with funds: it renders summaries and
 * Confirm/Cancel buttons, holds conversation state, and forwards confirmed
 * plans to the isolated Signer. It never touches keys.
 */

interface PendingAction {
  intent: Intent;
  plan: CallPlan;
  createdAt: number;
}

// Conversation state (README §3: Redis in production). In-memory here.
const pending = new Map<string, PendingAction>();
const PENDING_TTL_MS = 5 * 60_000;

export function createBot(): Bot {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set. Use `npm run demo` to exercise the pipeline offline.");
  }

  const bot = new Bot(config.telegramToken);
  const pipeline = new Pipeline();

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "👋 Mezo agent ready. I operate Borrow, Swap, Earn/zap, Locking, Voting and Claims.",
        "",
        "Every fund-moving action is simulated and shown for confirmation before signing.",
        `Signer mode: *${signer.mode}*.`,
        "",
        "Try: _borrow with 0.1 BTC, mint 5000 MUSD_",
      ].join("\n"),
      { parse_mode: "Markdown" },
    ),
  );

  bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const action = pending.get(key);
    pending.delete(key);
    if (!action) {
      await ctx.answerCallbackQuery({ text: "This confirmation expired." });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = String(ctx.from?.id ?? key);
    const result = await signer.signAndSubmit(userId, action.intent, action.plan);
    const msg = result.submitted
      ? `✅ Submitted.\nTx: \`${result.txHash}\`\n${result.reason ?? ""}`
      : `🧪 Not submitted.\n${result.reason ?? ""}`;
    await ctx.editMessageText(msg, { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    pending.delete(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("❌ Cancelled. No transaction was signed.");
  });

  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from?.id ?? ctx.chat.id);
    const outcome = await pipeline.handle(userId, ctx.message.text);
    await respond(ctx, userId, outcome);
  });

  return bot;
}

async function respond(ctx: Context, userId: string, outcome: PipelineOutcome): Promise<void> {
  switch (outcome.kind) {
    case "clarify":
      await ctx.reply(`🤔 ${outcome.message}`);
      return;
    case "unsupported":
      await ctx.reply(`🚫 ${outcome.message}`);
      return;
    case "blocked":
      await ctx.reply(`🛑 ${outcome.message}`);
      return;
    case "read":
      await ctx.reply(outcome.message, { parse_mode: "Markdown" });
      return;
    case "confirm": {
      const key = `${userId}:${Date.now()}`;
      pending.set(key, { intent: outcome.intent, plan: outcome.plan, createdAt: Date.now() });
      sweepExpired();
      const kb = new InlineKeyboard()
        .text("✅ Confirm", `confirm:${key}`)
        .text("❌ Cancel", `cancel:${key}`);
      await ctx.reply(outcome.summary, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
}
