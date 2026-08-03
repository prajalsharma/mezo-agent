import { Bot, InlineKeyboard, type Context } from "grammy";
import { formatUnits } from "viem";
import { env, llmEnabled, feesEnabled, accessRestricted } from "../config/env.js";
import { log } from "../core/log.js";
import { registry } from "../registry/registry.js";
import { parseIntent, resolveDollarPhrases } from "../llm/adapter.js";
import { btcPriceUsd } from "../core/prices.js";
import { getPortfolio, prettyAmount } from "../portfolio/portfolioService.js";
import { esc, mdToHtml, b, i, code } from "./format.js";
import {
  handleStart,
  handleCreate,
  handleImportPrompt,
  handleExportPrompt,
  handleExportConfirm,
  handleExportCancel,
  maybeHandleImportKey,
  looksLikeSecret,
} from "./handlers/onboarding.js";
import { handlePortfolio, handleDeposit } from "./handlers/portfolio.js";
import { handleLimits, handleWatch, handleLimitsConfirm, handleLimitsCancel } from "./handlers/limits.js";
import { handleUpgrade } from "./handlers/delegate.js";
import {
  handleSwapIntent,
  handleSwapConfirm,
  handleSwapCancel,
} from "./handlers/swap.js";
import { handleActionIntent, handleActionConfirm, handleActionCancel } from "./handlers/actions.js";
import { handleAccount, handleDcaCreate, handleDcaCancel, handleAutoCompound } from "./handlers/automation.js";
import { clearPending } from "./session.js";
import { store } from "../db/store.js";
import { runPreflight, formatPreflightText } from "../core/preflight.js";
import { getUser } from "../wallet/walletService.js";
import { installBotProfile, homeCard, screenCard, feesText } from "./menu.js";
import { explainerFor } from "./explainers.js";
import { handleMenuCallback, handleReferral, setBotUsername, helpText } from "./handlers/menu.js";

/** Last free-text message per user, for one-turn conversational context. */
const lastUserMessage = new Map<number, string>();
/** GUIDE-mode suggested commands per user (tappable buttons carry an index). */
const suggestionCache = new Map<number, string[]>();

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

  // ── Access gate ─────────────────────────────────────────────────────────────
  // Registered before every handler so nothing below it can be reached by an
  // unlisted user. A Telegram bot has no "private" mode — anyone who learns the
  // username can message it — so during local development this allowlist is what
  // keeps a stranger from onboarding a wallet on your instance.
  //
  // We log the rejected ID (that is how you discover your own) but reply with
  // nothing: a silent bot gives a scanner no signal that the token is live.
  if (accessRestricted) {
    bot.use(async (ctx, next) => {
      const id = ctx.from?.id;
      if (id === undefined || !env.allowedUserIds.has(id)) {
        log.warn("access.denied", { telegramId: id ?? "unknown" });
        return; // drop, no reply
      }
      await next();
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.command("start", handleStart);
  // Single source of truth for help copy: helpText() builds its examples from
  // the live registry (real pools/tokens/vaults on this network).
  bot.command("help", async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: "HTML" });
  });
  bot.command("portfolio", handlePortfolio);
  bot.command("deposit", handleDeposit);
  bot.command("limits", handleLimits);
  bot.command("upgrade", handleUpgrade);
  bot.command("watch", handleWatch);
  bot.command("export", handleExportPrompt);
  bot.command("accounts", (ctx) => handleAccount(ctx, { action: "account", op: "list" }));
  bot.command("dca", (ctx) => handleDcaCancel(ctx, { action: "dcaCancel" }));
  bot.command("referral", handleReferral);

  // Feature commands that MIRROR the home tiles — each opens its submenu card, so
  // buttons and slash commands cover the same features (navigation consistency).
  const openScreen = (screen: string) => async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const card = await screenCard(screen, uid);
    if (card) await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard, link_preview_options: { is_disabled: true } });
    else await ctx.reply("Send /start to create a wallet first.");
  };
  bot.command("swap", openScreen("swap"));
  bot.command("borrow", openScreen("borrow"));
  bot.command("earn", openScreen("earn"));
  bot.command("vote", openScreen("lockvote"));
  bot.command("automate", openScreen("automate"));
  bot.command("settings", openScreen("settings"));
  bot.command("alerts", openScreen("alerts"));
  bot.command("learn", openScreen("learn"));

  // Emergency stop for scheduled automation (bounty: access controls / kill-switch).
  bot.command("pause", async (ctx) => {
    if (!ctx.from?.id) return;
    store.setUserPaused(ctx.from.id, true);
    await ctx.reply(
      "🛑 <b>Automation paused.</b>\nAll your DCA / auto-compound runs are frozen. " +
        "Your schedules are kept - send /resume to re-enable. Manual actions still work.",
      { parse_mode: "HTML" },
    );
  });
  bot.command("resume", async (ctx) => {
    if (!ctx.from?.id) return;
    store.setUserPaused(ctx.from.id, false);
    await ctx.reply("▶️ <b>Automation resumed.</b>", { parse_mode: "HTML" });
  });

  // Transparent fee disclosure — the bounty requires fees be disclosed in-bot.
  // Shared, always-current disclosure (includes the referred discount + split).
  bot.command("fees", async (ctx) => {
    await ctx.reply(feesText(), { parse_mode: "HTML" });
  });
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
  bot.callbackQuery("wallet:export-confirm", handleExportConfirm);
  bot.callbackQuery("wallet:export-cancel", handleExportCancel);
  bot.callbackQuery("limits:confirm", handleLimitsConfirm);
  bot.callbackQuery("limits:cancel", handleLimitsCancel);
  bot.callbackQuery("swap:confirm", handleSwapConfirm);
  bot.callbackQuery("swap:cancel", handleSwapCancel);
  bot.callbackQuery("action:confirm", handleActionConfirm);
  bot.callbackQuery("action:cancel", handleActionCancel);
  bot.callbackQuery(/^menu:/, handleMenuCallback);

  // ── Free text → intent → the right surface ───────────────────────────────────
  bot.on("message:text", async (ctx) => {
    // A pending private-key import consumes the next message.
    if (await maybeHandleImportKey(ctx)) return;

    const text = ctx.message.text;

    // UNCONDITIONAL secret guard (Audit R2 C3). Even outside an import flow — a
    // lapsed window, a re-paste after a failed import, or a user pasting a key
    // unprompted — a private key or seed phrase must NEVER reach parseIntent
    // (which posts the message to the LLM). Detect the shape, delete the
    // message, and refuse. This runs before any LLM call.
    if (looksLikeSecret(text)) {
      await ctx.deleteMessage().catch(() => {});
      clearPending(ctx.from?.id ?? 0);
      await ctx.reply(
        "🛑 That looked like a private key or seed phrase, so I deleted it and did NOT process it. " +
          "Never paste secrets unprompted. To import, tap Import on /start first, then paste when asked.",
      );
      return;
    }

    if (text.startsWith("/")) return; // unknown command; ignore

    // Plain-language shortcuts for common meta phrases the parser has no intent
    // for (faucet, help, menu, deposit) — so "access the faucet" or "menu" just
    // work instead of returning a token-list clarify. (UX fix.)
    const lower = text.toLowerCase();
    const uid = ctx.from?.id;
    const hasAccount = uid ? Boolean(getUser(uid)) : false;
    if (/\bfaucet\b/.test(lower)) {
      const fk = new InlineKeyboard()
        .webApp("🚰 Open faucet", "https://faucet.test.mezo.org/").row()
        .text("📥 My deposit address", "menu:act:deposit");
      await ctx.reply(
        "🚰 <b>Testnet faucet</b>\nTap below to open the faucet in-app, then paste your deposit address to get test BTC.",
        { parse_mode: "HTML", reply_markup: fk, link_preview_options: { is_disabled: true } },
      );
      return;
    }
    if (/^\s*(help|commands?|what can you do\??)\s*$/.test(lower)) { await ctx.reply(helpText(), { parse_mode: "HTML" }); return; }
    if (/^\s*(menu|home|main menu|start over)\s*$/.test(lower)) {
      const home = uid ? await homeCard(uid) : undefined;
      if (home) await ctx.reply(home.text, { parse_mode: "HTML", reply_markup: home.menu, link_preview_options: { is_disabled: true } });
      else await ctx.reply("Send /start to create or import a wallet.");
      return;
    }
    if (/^\s*(deposit|fund|my address)\s*$/.test(lower)) { await handleDeposit(ctx); return; }

    // Static ELI5 explainers — "what is liquidation?" etc. get a hand-written,
    // zero-hallucination answer instantly (HeyAnon pattern), before any parsing.
    {
      const ex = explainerFor(text);
      if (ex) {
        const suggestions = [...ex.matchAll(/"([^"\n]{3,64})"/g)].map((m) => m[1]!).slice(0, 3);
        const kb = new InlineKeyboard();
        if (uid && suggestions.length) {
          suggestionCache.set(uid, suggestions);
          suggestions.forEach((sug, idx) => kb.text(`▶ ${sug.length > 40 ? sug.slice(0, 39) + "…" : sug}`, `sugg:${idx}`).row());
        }
        kb.text("🏠 Menu", "menu:home");
        await ctx.reply(ex, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
        return;
      }
    }

    // "borrow 2500 MUSD" with NO collateral named used to dead-end on a bare
    // "how much BTC?" question. Answer it: compute the BTC actually required at
    // the live price (150% target = comfortable buffer over the 110% minimum)
    // and hand back a ready-to-tap command.
    {
      const m = text.match(/\bborrow\s+([\d,]+(?:\.\d+)?)\s*musd\b/i);
      // "against BTC" with NO number is still an unsized borrow — require a
      // numeric amount, otherwise the sizing helper is skipped and the user
      // dead-ends on "I didn't catch that" (exactly what happened live).
      const hasCollateral = /\b(?:against|with|using)\s+\d+(?:\.\d+)?\s*btc/i.test(text);
      if (m && !hasCollateral) {
        const debt = Number(m[1]!.replace(/,/g, ""));
        const MIN_DEBT = 1800;
        if (debt > 0 && debt < MIN_DEBT) {
          await ctx.reply(
            `⚠️ Mezo's minimum loan is ${b("1,800 MUSD")} - ${debt.toLocaleString()} is below it.\n\n` +
              `Try: ${code(`borrow 1800 MUSD against 0.05 BTC`)}`,
            { parse_mode: "HTML" },
          );
          return;
        }
        const price = await btcPriceUsd().catch(() => undefined);
        if (debt >= MIN_DEBT && price) {
          const gross = debt * 1.01; // ~1% borrow fee
          const minBtc = (1.1 * gross) / price;
          const safeBtc = Number(((1.5 * gross) / price).toFixed(4));
          const cmd = `borrow ${debt} MUSD against ${safeBtc} BTC`;
          if (uid) suggestionCache.set(uid, [cmd]);
          await ctx.reply(
            `${b(`To borrow ${debt.toLocaleString()} MUSD you need BTC collateral:`)}\n\n` +
              `• Bare minimum (110%): ${b(`${minBtc.toFixed(4)} BTC`)} - liquidated on any dip\n` +
              `• ${b("Recommended")} (150% buffer): ${b(`${safeBtc} BTC`)}\n\n` +
              i(`At the live price of $${Math.round(price).toLocaleString()}/BTC. You'll see the exact ratio and confirm before anything signs.`),
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text(`▶ ${cmd}`, "sugg:0").row().text("🏠 Menu", "menu:home"),
            },
          );
          return;
        }
      }
    }

    // Dollar-denominated phrasing ("swap $50 of BTC…") → token units, before any
    // parsing. Deterministic (stables $1, BTC via the live PriceFeed).
    const symbols = registry.knownTokenSymbols();
    let parsedText = text;
    try { parsedText = await resolveDollarPhrases(text, symbols); } catch { /* keep original */ }

    // Fraction phrasing ("half my MUSD", "all my BTC", "25% of my musd") →
    // token units from the LIVE balance, in code, never by LLM arithmetic.
    // "all" of the gas token keeps a reserve so the tx can still be sent
    // (industry rule — ElizaOS uses 0.9×; we keep a fixed gas buffer).
    if (uid && hasAccount && /\b(all|half|\d{1,2}\s?%)\s+(?:of\s+)?my\s+[a-z0-9]+/i.test(parsedText)) {
      try {
        const holder = getUser(uid)!;
        const holdings = await getPortfolio(holder.address);
        parsedText = parsedText.replace(/\b(all|half|(\d{1,2})\s?%)\s+(?:of\s+)?my\s+([a-zA-Z0-9]+)/gi, (whole, word: string, pct: string | undefined, tok: string) => {
          const h = holdings.find((x) => x.token.symbol.toLowerCase() === tok.toLowerCase() || x.token.symbol.toLowerCase() === "m" + tok.toLowerCase());
          if (!h || h.raw <= 0n) return whole;
          let raw = word.toLowerCase() === "half" ? h.raw / 2n
            : pct ? (h.raw * BigInt(Math.min(Number(pct), 100))) / 100n
            : h.raw; // "all"
          if (word.toLowerCase() === "all" && h.token.native) {
            const GAS_BUFFER = 500_000_000_000_000n; // 0.0005 BTC for gas
            raw = raw > GAS_BUFFER ? raw - GAS_BUFFER : 0n;
          }
          if (raw <= 0n) return whole;
          return `${formatUnits(raw, h.token.decimals)} ${h.token.symbol}`;
        });
      } catch { /* balances unavailable - leave the phrase for clarify/LLM */ }
    }

    // Conversational context: remember the last message per user so a follow-up
    // like "do it to MUSD then" can inherit the amount/tokens from it.
    const prior = uid ? lastUserMessage.get(uid) : undefined;
    if (uid) lastUserMessage.set(uid, text);

    // Lazy grounding for GUIDE mode: the user's real balances, live routes and
    // the BTC price — fetched only when the rule parser can't handle the message.
    const ground = async (): Promise<string> => {
      const lines: string[] = [];
      lines.push(`Network: Mezo ${env.network}. Tokens: ${symbols.join(", ")}.`);
      lines.push(`Swap routes: ${registry.pools().map((p) => p.pair.join("/")).join(", ")}.`);
      const price = await btcPriceUsd().catch(() => undefined);
      if (price) lines.push(`BTC price: $${Math.round(price).toLocaleString()}. MUSD and m-stables are $1.`);
      if (uid && hasAccount) {
        try {
          const user = getUser(uid)!;
          const holdings = (await getPortfolio(user.address)).filter((h) => h.raw > 0n);
          lines.push(holdings.length
            ? `User balances: ${holdings.map((h) => `${prettyAmount(h.formatted)} ${h.token.symbol}`).join(", ")}.`
            : "User balances: empty (needs to deposit first).");
        } catch { /* balances unavailable */ }
      } else {
        lines.push("User has NO wallet yet - first step is /start to create one.");
      }
      lines.push(
        "Facts: borrow mints MUSD against BTC (min debt 1,800 MUSD, keep collateral ≥110% or risk liquidation). " +
        "Zap turns one asset into a staked LP position. Locks: veBTC 1-28 days, veMEZO up to 4 years; longer = more voting power. " +
        "Claiming rewards and voting are free of agent fees. Swaps/zaps show a quote + confirmation before anything signs.",
      );
      return lines.join("\n");
    };

    const intent = await parseIntent(parsedText, symbols, prior, ground, { lastPool: uid ? store.lastPool(uid) : undefined });
    if (intent.action === "chat") {
      // GUIDE mode: display-only answer, escaped. The quoted example commands
      // in the answer become TAPPABLE buttons that feed straight back into the
      // deterministic parser — conversation teaches the grammar (Neur/Griffain
      // suggestion-card pattern).
      const suggestions = [...intent.text.matchAll(/"([^"\n]{3,64})"/g)].map((m) => m[1]!).slice(0, 3);
      const kb = new InlineKeyboard();
      if (uid && suggestions.length) {
        suggestionCache.set(uid, suggestions);
        suggestions.forEach((s, idx) => kb.text(`▶ ${s.length > 40 ? s.slice(0, 39) + "…" : s}`, `sugg:${idx}`).row());
      }
      kb.text("🏠 Menu", "menu:home");
      await ctx.reply(mdToHtml(intent.text), { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
      return;
    }
    await routeIntent(ctx, intent, uid, hasAccount);
  });

  /** Route a validated intent to its handler (shared by typed messages and
   *  tapped suggestion buttons — both go through the same deterministic path). */
  async function routeIntent(ctx: Context, intent: Exclude<Awaited<ReturnType<typeof parseIntent>>, { action: "chat" }>, uid: number | undefined, hasAccount: boolean): Promise<void> {
    switch (intent.action) {
      case "swap": return void (await handleSwapIntent(ctx, intent));
      case "portfolio": return void (await handlePortfolio(ctx));
      case "account": return void (await handleAccount(ctx, intent));
      case "dcaCreate": return void (await handleDcaCreate(ctx, intent));
      case "dcaCancel": return void (await handleDcaCancel(ctx, intent));
      case "autoCompound": return void (await handleAutoCompound(ctx, intent));
      case "clarify": {
        // Account-aware: guide a new user to /start; show a returning user their
        // menu instead of a bare token list. (UX fix — the bot "remembers" you.)
        if (!hasAccount) {
          await ctx.reply(`${intent.question}\n\nNew here? Send /start to create or import a wallet.`);
        } else {
          const home = uid ? await homeCard(uid) : undefined;
          await ctx.reply(intent.question);
          if (home) await ctx.reply("Or tap an action:", { reply_markup: home.menu });
        }
        return;
      }
      default: {
        // Every fund-moving surface goes through the generic action handler.
        const handled = await handleActionIntent(ctx, intent);
        if (!handled) await ctx.reply("I couldn't map that to a supported action. Try /help.");
      }
    }
  }

  // Tapped GUIDE-mode suggestion → run the quoted command through the SAME
  // deterministic pipeline as a typed message (never a shortcut past preview/
  // confirm). Suggestions are server-cached per user; callback data carries only
  // an index (Telegram's 64-byte limit, and no user-controlled text execution).
  bot.callbackQuery(/^sugg:(\d)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from?.id;
    if (!uid) return;
    const text = suggestionCache.get(uid)?.[Number(ctx.match![1])];
    if (!text) { await ctx.reply("That suggestion expired - just type what you want."); return; }
    const symbols = registry.knownTokenSymbols();
    const parsed = await parseIntent(await resolveDollarPhrases(text, symbols).catch(() => text), symbols);
    if (parsed.action === "chat") { await ctx.reply(mdToHtml(parsed.text), { parse_mode: "HTML" }); return; }
    await routeIntent(ctx, parsed, uid, Boolean(getUser(uid)));
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
    `  LLM     : ${llmEnabled ? `${env.llm.provider} (${env.llm.provider === "gemini" ? env.llm.geminiModel : env.llm.anthropicModel})` : "deterministic fallback"}\n` +
    `  swaps   : ${registry.hasContract("Router") ? "router configured" : "router pending registry confirmation"}\n` +
    `  access  : ${
      accessRestricted
        ? `restricted to ${env.allowedUserIds.size} allowlisted user id(s)`
        : "⚠️  OPEN - anyone who finds the bot username can use it"
    }`
  );
}
