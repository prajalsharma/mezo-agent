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
import { handleLimits, handleWatch } from "./handlers/limits.js";
import { handleUpgrade } from "./handlers/delegate.js";
import {
  handleSwapIntent,
  handleSwapConfirm,
  handleSwapCancel,
} from "./handlers/swap.js";
import { handleActionIntent, handleActionConfirm, handleActionCancel } from "./handlers/actions.js";
import { handleAccount, handleDcaCreate, handleDcaCancel, handleAutoCompound } from "./handlers/automation.js";
import { clearPending } from "./session.js";
import { runPreflight, formatPreflightText } from "../core/preflight.js";
import { getUser } from "../wallet/walletService.js";

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
        "/start — onboarding · /portfolio · /deposit\n" +
        "/limits — spending caps · /watch — read-only mode\n" +
        "/upgrade — EIP-7702 smart account (scoped session key)\n" +
        "/accounts — multi-account · /dca — DCA schedules\n" +
        "/cancel · /diag — health self-test\n\n" +
        "Natural language — I understand:\n" +
        "• swap 100 MUSD to mUSDC · zap 0.01 BTC into MUSD/mUSDC\n" +
        "• borrow 5000 MUSD against 0.1 BTC · repay 1000 MUSD\n" +
        "• lock 0.2 BTC for 28 days · vote optimally · claim all\n" +
        "• stake LP MUSD/mUSDC · buy listing 42\n" +
        "• DCA 50 MUSD to BTC every 24h · auto-compound on\n" +
        "• new account · switch to account 1\n\n" +
        "Every fund-moving action is simulated and shown for confirmation before signing.",
    );
  });
  bot.command("portfolio", handlePortfolio);
  bot.command("deposit", handleDeposit);
  bot.command("limits", handleLimits);
  bot.command("upgrade", handleUpgrade);
  bot.command("watch", handleWatch);
  bot.command("accounts", (ctx) => handleAccount(ctx, { action: "account", op: "list" }));
  bot.command("dca", (ctx) => handleDcaCancel(ctx, { action: "dcaCancel" }));
  bot.command("cancel", async (ctx) => {
    if (ctx.from?.id) clearPending(ctx.from.id);
    await ctx.reply("Cancelled.");
  });

  // Self-test — pinpoints which subsystem is broken (config/keystore/store/rpc)
  // and whether the caller already has an account. Safe, read-only for the user.
  bot.command("diag", async (ctx) => {
    await ctx.reply("🩺 Running diagnostics…");
    const results = await runPreflight();
    const account = ctx.from?.id ? getUser(ctx.from.id) : undefined;
    const accountLine = account
      ? `\n\n👤 Your account exists: ${account.address}`
      : "\n\n👤 You have no account yet (tap Create on /start).";
    await ctx.reply(formatPreflightText(results) + accountLine);
  });

  // ── Inline buttons ──────────────────────────────────────────────────────────
  bot.callbackQuery("wallet:create", handleCreate);
  bot.callbackQuery("wallet:import", handleImportPrompt);
  bot.callbackQuery("swap:confirm", handleSwapConfirm);
  bot.callbackQuery("swap:cancel", handleSwapCancel);
  bot.callbackQuery("action:confirm", handleActionConfirm);
  bot.callbackQuery("action:cancel", handleActionCancel);

  // ── Free text → intent → the right surface ───────────────────────────────────
  bot.on("message:text", async (ctx) => {
    // A pending private-key import consumes the next message.
    if (await maybeHandleImportKey(ctx)) return;

    const text = ctx.message.text;
    if (text.startsWith("/")) return; // unknown command; ignore

    const intent = await parseIntent(text, registry.knownTokenSymbols());
    switch (intent.action) {
      case "swap": return void (await handleSwapIntent(ctx, intent));
      case "portfolio": return void (await handlePortfolio(ctx));
      case "account": return void (await handleAccount(ctx, intent));
      case "dcaCreate": return void (await handleDcaCreate(ctx, intent));
      case "dcaCancel": return void (await handleDcaCancel(ctx, intent));
      case "autoCompound": return void (await handleAutoCompound(ctx, intent));
      case "clarify": return void (await ctx.reply(intent.question));
      default: {
        // Every fund-moving surface goes through the generic action handler.
        const handled = await handleActionIntent(ctx, intent);
        if (!handled) await ctx.reply("I couldn't map that to a supported action. Try /help.");
      }
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
