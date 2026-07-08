import { Bot } from "grammy";
import { env, llmEnabled } from "../config/env.js";
import { registry } from "../registry/registry.js";
import { parseIntent } from "../llm/adapter.js";
import {
  handleStart,
  handleCreate,
  handleImportPrompt,
  maybeHandleImportKey,
} from "./handlers/onboarding.js";
import { handlePortfolio, handleDeposit } from "./handlers/portfolio.js";
import {
  handleSwapIntent,
  handleSwapConfirm,
  handleSwapCancel,
} from "./handlers/swap.js";
import { clearPending } from "./session.js";

export function buildBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  // ── Error boundary ──────────────────────────────────────────────────────────
  // Registered FIRST so it wraps every downstream handler. Any thrown error is
  // surfaced to the user in-chat (never silent) and logged without secrets.
  // This is what turns "I tapped Create and nothing happened" into a real,
  // actionable message.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[handler error]", message);
      await ctx
        .reply(`⚠️ Something went wrong: ${message}`)
        .catch(() => {
          /* if even the error reply fails, we've already logged it */
        });
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.command("start", handleStart);
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        "/start — onboarding\n" +
        "/portfolio — your balances\n" +
        "/deposit — deposit address + QR\n" +
        "/cancel — cancel a pending action\n\n" +
        'Natural language: "swap 100 MUSD to mUSDC"',
    );
  });
  bot.command("portfolio", handlePortfolio);
  bot.command("deposit", handleDeposit);
  bot.command("cancel", async (ctx) => {
    if (ctx.from?.id) clearPending(ctx.from.id);
    await ctx.reply("Cancelled.");
  });

  // ── Inline buttons ──────────────────────────────────────────────────────────
  bot.callbackQuery("wallet:create", handleCreate);
  bot.callbackQuery("wallet:import", handleImportPrompt);
  bot.callbackQuery("swap:confirm", handleSwapConfirm);
  bot.callbackQuery("swap:cancel", handleSwapCancel);

  // ── Free text → intent ──────────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    // A pending private-key import consumes the next message.
    if (await maybeHandleImportKey(ctx)) return;

    const text = ctx.message.text;
    if (text.startsWith("/")) return; // unknown command; ignore

    const intent = await parseIntent(text, registry.knownTokenSymbols());
    if (intent.action === "swap") {
      await handleSwapIntent(ctx, intent);
    } else {
      await ctx.reply(intent.question);
    }
  });

  bot.catch((err) => {
    // Never log secrets. Errors here are framework/handler errors only.
    console.error("[bot] handler error:", err.error);
  });

  return bot;
}

export function startupBanner(): string {
  return (
    `Mezo Agent starting\n` +
    `  network : ${env.network}\n` +
    `  LLM     : ${llmEnabled ? `${env.llm.provider} (${env.llm.anthropicModel})` : "deterministic fallback"}\n` +
    `  swaps   : ${registry.hasContract("Router") ? "router configured" : "router pending registry confirmation"}`
  );
}
