import { parseEther } from "viem";
import type { Context } from "grammy";
import { getUser, setMode } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { limitsOf, fmtBtc, type SpendingLimits } from "../../custody/policy.js";
import { b, i } from "../format.js";

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
    if (field === "pertx") limits.perTxNativeWei = wei.toString();
    else if (field === "daily") limits.dailyNativeWei = wei.toString();
    else {
      await ctx.reply("❌ Unknown field. Use: /limits pertx <btc> or /limits daily <btc>");
      return;
    }
    user.limits = limits as SpendingLimits;
    store.saveUser(user);
    await ctx.reply(`✅ Updated. ${field} limit is now ${fmtBtc(wei)}.`);
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
