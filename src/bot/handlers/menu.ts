import { InlineKeyboard, type Context } from "grammy";
import { env, feesEnabled } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { registry } from "../../registry/registry.js";
import { homeCard, screenCard, tipCard, feesText, helpText, swapToCard, swapAmountCard, presetSwapAmount, type Card } from "../menu.js";
import { b, i, code } from "../format.js";
import { handlePortfolio, handleDeposit } from "./portfolio.js";
import { handleLimits } from "./limits.js";
import { handleActionIntent } from "./actions.js";
import { handleSwapIntent } from "./swap.js";
import { handleAutoCompound, handleDcaCancel, handleAccount } from "./automation.js";

export { helpText };

/** Bot username, cached after the first call (for referral links). */
let botUsername = "MezoAgentBot";
export function setBotUsername(u: string): void { botUsername = u; }

/** /referral — the deep-link + the revenue-share disclosure. */
export async function handleReferral(ctx: Context): Promise<void> {
  const id = ctx.from?.id;
  if (!id) return;
  if (!getUser(id)) { await ctx.reply("Create a wallet first with /start."); return; }
  const link = `https://t.me/${botUsername}?start=${id}`;
  const count = store.countReferrals(id);
  const earnings = store.referralEarnings(id);
  const hasDiscount = env.fees.referredBps < env.fees.swapBps;
  const body = feesEnabled
    ? [
        b("How it works — both sides win:"),
        `1. Share your link. Anyone who taps it and starts the bot is credited to you — ${b("for life")}.`,
        `2. ${b("They save:")} ${hasDiscount
          ? `referred traders pay ${b(`${env.fees.referredBps / 100}%`)} on swaps & zaps instead of ${env.fees.swapBps / 100}% — a lifetime discount your link unlocks.`
          : `referred traders pay the standard ${env.fees.swapBps / 100}% swap fee.`}`,
        `3. ${b("You earn:")} ${b(`${env.fees.referralSharePct}%`)} of the agent fee on ${b("every swap and zap they ever make")}.`,
        `4. ${b("Instant settlement:")} your share is split ${b("on-chain, inside their swap transaction")} and lands straight in your wallet. No claiming, no minimum, no waiting.`,
        "",
        b("Worked example:"),
        `Your referral swaps 1,000 MUSD → fee ${((1000 * env.fees.referredBps) / 10_000).toFixed(2)} MUSD (${env.fees.referredBps / 100}%) → ` +
          `${b(`${((1000 * env.fees.referredBps * env.fees.referralSharePct) / 1_000_000).toFixed(3)} MUSD`)} arrives in your wallet the moment their swap confirms.`,
        `Refer an active trader doing that daily and that's ~${b(`${((1000 * env.fees.referredBps * env.fees.referralSharePct * 30) / 1_000_000).toFixed(1)} MUSD/month`)} — from one person.`,
      ].join("\n")
    : `Referral rewards activate when the agent fee is enabled on this deployment (see /fees).`;
  const earnedLines = Object.entries(earnings.byToken).length
    ? "\n" + b("Earned so far:") + "\n" +
      Object.entries(earnings.byToken)
        .map(([sym, raw]) => `• ${fmtToken(sym, raw)} ${sym}`).join("\n") +
      `\n(${earnings.trades} referred trade${earnings.trades === 1 ? "" : "s"})\n`
    : "";
  await ctx.reply(
    `${b("🎁 Referral")}\n\n` +
      `Your personal link:\n${code(link)}\n\n` +
      `${body}\n\n` +
      `Referred so far: ${b(String(count))}\n` +
      earnedLines +
      "\n" + i("Your share comes out of the agent fee — it never costs your referrals anything extra. Full rates: /fees."),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

function fmtToken(sym: string, raw: string): string {
  // Decimals from the registry (BTC=18, mUSDC/mUSDT=6, bridged BTC variants=8…),
  // not a hardcoded 18 (Audit R3 F8).
  const d = registry.tryToken(sym)?.decimals ?? 18;
  const v = Number(BigInt(raw)) / 10 ** d;
  return v < 0.0001 ? v.toExponential(2) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Router for all `menu:*` inline-button callbacks. Navigation (home / nav / tip)
 * is EDITED IN PLACE on the same message; actions (do:*) and info handlers
 * (act:*) run the existing handlers.
 */
export async function handleMenuCallback(ctx: Context): Promise<void> {
  const rest = (ctx.callbackQuery?.data ?? "").slice("menu:".length);
  await ctx.answerCallbackQuery().catch(() => {});
  const uid = ctx.from?.id;
  if (!uid) return;

  // Edit the current message into a new card; fall back to a fresh reply if the
  // message can't be edited (e.g. it's a photo, or already identical).
  const edit = async (card: Card | { text: string; keyboard: InlineKeyboard }) => {
    const opts = { parse_mode: "HTML" as const, reply_markup: card.keyboard, link_preview_options: { is_disabled: true } };
    try { await ctx.editMessageText(card.text, opts); }
    catch { await ctx.reply(card.text, opts); }
  };

  // Home / refresh → the wallet+balance home card.
  if (rest === "home" || rest === "refresh") {
    const home = await homeCard(uid);
    if (home) await edit({ text: home.text, keyboard: home.menu });
    else await ctx.reply("Create a wallet first with /start.");
    return;
  }

  // Navigate to a submenu card.
  if (rest.startsWith("nav:")) {
    const card = await screenCard(rest.slice("nav:".length), uid);
    if (card) await edit(card);
    else await ctx.reply("That screen isn't available.");
    return;
  }

  // Guidance sub-card for a parameterized action.
  if (rest.startsWith("tip:")) {
    const card = tipCard(rest.slice("tip:".length));
    if (card) await edit(card);
    return;
  }

  // Swap picker flow: source → destination → preset amount → quote/confirm.
  if (rest.startsWith("swapfrom:")) {
    await edit(await swapToCard(rest.slice("swapfrom:".length)));
    return;
  }
  if (rest.startsWith("swapto:")) {
    const [from, to] = rest.slice("swapto:".length).split(":");
    if (from && to) await edit(await swapAmountCard(from, to, uid));
    return;
  }
  if (rest.startsWith("swapx:")) {
    const [from, to, pct] = rest.slice("swapx:".length).split(":");
    if (!from || !to || !pct) return;
    const amount = await presetSwapAmount(uid, from, Number(pct));
    if (!amount) { await ctx.reply("Couldn't read your balance for that — try typing the swap amount."); return; }
    await handleSwapIntent(ctx, { action: "swap", amount, fromToken: from, toToken: to });
    return;
  }

  // Parameter-free actions — run through the normal intent handlers (which
  // simulate + show a confirm card as needed).
  if (rest.startsWith("do:")) {
    const a = rest.slice("do:".length);
    switch (a) {
      case "closeTrove": await handleActionIntent(ctx, { action: "closeTrove" }); return;
      case "claim": await handleActionIntent(ctx, { action: "claim", scope: "all" }); return;
      case "dcalist": await handleDcaCancel(ctx, { action: "dcaCancel" }); return;
      case "newaccount": await handleAccount(ctx, { action: "account", op: "new" }); return;
      case "autocompound_on": await handleAutoCompound(ctx, { action: "autoCompound", enabled: true }); return;
      case "autocompound_off": await handleAutoCompound(ctx, { action: "autoCompound", enabled: false }); return;
    }
    return;
  }

  // Info handlers that render their own message.
  if (rest.startsWith("act:")) {
    const a = rest.slice("act:".length);
    switch (a) {
      case "portfolio": await handlePortfolio(ctx); return;
      case "deposit": await handleDeposit(ctx); return;
      case "limits": await handleLimits(ctx); return;
      case "referral": await handleReferral(ctx); return;
      case "fees": await ctx.reply(feesText(), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🏠 Menu", "menu:home") }); return;
    }
    return;
  }

  // Legacy callback names (older messages still in a chat).
  if (rest === "portfolio") { await handlePortfolio(ctx); return; }
  if (rest === "deposit") { await handleDeposit(ctx); return; }
  if (rest === "limits") { await handleLimits(ctx); return; }
  if (rest === "referral") { await handleReferral(ctx); return; }
  if (rest === "help") { const c = await screenCard("help", uid); if (c) await edit(c); return; }
  if (rest.startsWith("guide:")) { const c = await screenCard(rest.slice("guide:".length), uid); if (c) await edit(c); return; }
}
