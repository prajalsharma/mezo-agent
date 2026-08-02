import { parseEther, parseUnits } from "viem";
import { InlineKeyboard, type Context } from "grammy";
import { getUser, setMode } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { limitsOf, fmtBtc, type SpendingLimits } from "../../custody/policy.js";
import { b, i } from "../format.js";

/**
 * Pending cap-INCREASE requests, awaiting an explicit confirmation tap.
 * Raising a cap is the one /limits action that can enable a drain, so — like
 * /export — it needs a second step rather than a single unconfirmed message
 * from the same (possibly compromised) session. (Audit R2 H9.) Decreases apply
 * immediately (they only tighten). Keyed by telegramId.
 */
const pendingRaise = new Map<number, { field: string; wei: bigint; token?: string; raw?: bigint }>();

/**
 * /limits — view/adjust spending caps and watch-only mode. These are the
 * "spending limits and confirmation thresholds so a compromised session cannot
 * drain an account" the bounty requires. Caps are enforced in the signer.
 *
 * Usage:
 *   /limits                     → show current caps + 24h usage
 *   /limits pertx 0.05          → set per-transaction native cap (BTC)
 *   /limits daily 0.2           → set rolling 24h native cap (BTC)
 */
export async function handleLimits(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }

  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  const limits = { ...limitsOf(user.limits) };

  // /limits token <SYMBOL> <amount> — set a per-token raw cap (Audit R2 H8).
  if (parts.length >= 3 && parts[0] === "token") {
    const sym = parts[1]!;
    const dec = { MUSD: 18, mUSDC: 6, mUSDT: 6, MEZO: 18 }[sym] ?? 18;
    let raw: bigint;
    try { raw = parseUnits(parts[2]!, dec); if (raw <= 0n) throw new Error(); }
    catch { await ctx.reply(`❌ "${parts[2]}" is not a valid ${sym} amount.`); return; }
    const current = BigInt(limitsOf(user.limits).perTxTokenCaps[sym] ?? "0");
    if (raw > current) {
      pendingRaise.set(telegramId, { field: `token ${sym}`, wei: 0n, token: sym, raw });
      await ctx.reply(
        `⚠️ Raise the ${sym} per-tx cap to ${parts[2]}? A higher cap lets a single action move more. Confirm to apply.`,
        { reply_markup: new InlineKeyboard().text("Confirm raise", "limits:confirm").row().text("Cancel", "limits:cancel") },
      );
      return;
    }
    limits.perTxTokenCaps = { ...limitsOf(user.limits).perTxTokenCaps, [sym]: raw.toString() };
    user.limits = limits as SpendingLimits;
    store.saveUser(user);
    await ctx.reply(`✅ ${sym} per-tx cap tightened to ${parts[2]}.`);
    return;
  }

  if (parts.length >= 2) {
    const [field, value] = parts;
    let wei: bigint;
    try {
      wei = parseEther(value!);
      if (wei <= 0n) throw new Error("must be > 0");
    } catch {
      await ctx.reply(`❌ "${value}" is not a valid BTC amount, e.g. /limits pertx 0.05`);
      return;
    }
    if (field !== "pertx" && field !== "daily") {
      await ctx.reply("❌ Unknown field. Use: /limits pertx <btc>, /limits daily <btc>, or /limits token <SYM> <amt>");
      return;
    }
    const current = BigInt(field === "pertx" ? limits.perTxNativeWei : limits.dailyNativeWei);
    // A RAISE needs an explicit confirmation; a decrease (tightening) applies now.
    if (wei > current) {
      pendingRaise.set(telegramId, { field, wei });
      await ctx.reply(
        `⚠️ Raise your ${field} limit from ${fmtBtc(current)} to ${fmtBtc(wei)}?\n\n` +
          `A higher limit lets a single ${field === "daily" ? "day" : "transaction"} move more BTC - this is exactly what a compromised session would try. Confirm only if you meant to.`,
        { reply_markup: new InlineKeyboard().text("Confirm raise", "limits:confirm").row().text("Cancel", "limits:cancel"), parse_mode: "HTML" },
      );
      return;
    }
    if (field === "pertx") limits.perTxNativeWei = wei.toString();
    else limits.dailyNativeWei = wei.toString();
    user.limits = limits as SpendingLimits;
    store.saveUser(user);
    await ctx.reply(`✅ Tightened. ${field} limit is now ${fmtBtc(wei)}.`);
    return;
  }

  const spent = store.spentLast24hWei(telegramId);
  await ctx.reply(
    `${b("Spending limits")} (native BTC)\n` +
      `• Per transaction: ${fmtBtc(limits.perTxNativeWei)}\n` +
      `• Daily (rolling 24h): ${fmtBtc(limits.dailyNativeWei)}\n` +
      `• Spent last 24h: ${fmtBtc(spent)}\n` +
      `• Step-up confirm above: ${fmtBtc(limits.confirmationThresholdNativeWei)}\n` +
      `• Mode: ${user.mode === "watch-only" ? "👀 watch-only (signing blocked)" : "✍️ active"}\n\n` +
      i("Change with /limits pertx 0.05 or /limits daily 0.2. Toggle signing with /watch on|off.") +
      "\n" +
      i("Note: caps currently cover native BTC value; per-token USD caps arrive with the price feed."),
    { parse_mode: "HTML" },
  );
}

/** Confirm a pending cap increase (Audit R2 H9). */
export async function handleLimitsConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const req = pendingRaise.get(telegramId);
  const user = getUser(telegramId);
  if (!req || !user) { await ctx.reply("Nothing pending."); return; }
  pendingRaise.delete(telegramId);
  const limits = { ...limitsOf(user.limits) };
  if (req.token && req.raw !== undefined) {
    limits.perTxTokenCaps = { ...limits.perTxTokenCaps, [req.token]: req.raw.toString() };
    user.limits = limits as SpendingLimits;
    store.saveUser(user);
    await ctx.reply(`✅ ${req.token} per-tx cap raised.`);
    return;
  }
  if (req.field === "pertx") limits.perTxNativeWei = req.wei.toString();
  else if (req.field === "daily") limits.dailyNativeWei = req.wei.toString();
  user.limits = limits as SpendingLimits;
  store.saveUser(user);
  await ctx.reply(`✅ ${req.field} limit raised to ${fmtBtc(req.wei)}. (This change was explicitly confirmed.)`);
}

export async function handleLimitsCancel(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.from?.id) pendingRaise.delete(ctx.from.id);
  await ctx.reply("Cap change cancelled. Limits unchanged.");
}

/** /watch on|off — enter/leave read-only mode (blocks all signing). */
export async function handleWatch(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  if (!getUser(telegramId)) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }
  const arg = (ctx.message?.text ?? "").trim().split(/\s+/)[1]?.toLowerCase();
  if (arg !== "on" && arg !== "off") {
    await ctx.reply("Usage: /watch on  (block signing)  |  /watch off  (allow signing)");
    return;
  }
  const mode = arg === "on" ? "watch-only" : "active";
  setMode(telegramId, mode);
  await ctx.reply(
    mode === "watch-only"
      ? "👀 Watch-only mode ON. All signing is blocked until you /watch off."
      : "✍️ Watch-only mode OFF. Signing re-enabled (still within your /limits).",
  );
}
