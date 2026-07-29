import type { Context } from "grammy";
import { env, feesEnabled } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { store } from "../../db/store.js";
import { homeCard, GUIDES, mainMenu } from "../menu.js";
import { b, i, code } from "../format.js";
import { handlePortfolio, handleDeposit } from "./portfolio.js";
import { handleLimits } from "./limits.js";

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
  const shareLine = feesEnabled
    ? `You earn ${b(`${env.fees.referralSharePct ?? 30}%`)} of the agent fee on swaps/zaps by people you refer.`
    : `Referral rewards activate when the agent fee is enabled on this deployment (see /fees).`;
  await ctx.reply(
    `${b("🎁 Referral")}\n\n` +
      `Share your link — anyone who starts the bot through it is credited to you:\n${code(link)}\n\n` +
      `${shareLine}\n` +
      `Referred so far: ${b(String(count))}\n\n` +
      i("Rewards are paid from the agent fee, so they cost your referrals nothing extra."),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

/** Router for all `menu:*` inline-button callbacks. */
export async function handleMenuCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const action = data.slice("menu:".length);
  await ctx.answerCallbackQuery().catch(() => {});

  if (action === "portfolio") return void (await handlePortfolio(ctx));
  if (action === "deposit") return void (await handleDeposit(ctx));
  if (action === "limits") return void (await handleLimits(ctx));
  if (action === "referral") return void (await handleReferral(ctx));
  if (action === "help") return void (await ctx.reply(helpText(), { parse_mode: "HTML" }));
  if (action === "refresh") {
    const home = ctx.from?.id ? await homeCard(ctx.from.id) : undefined;
    if (home) await ctx.reply(home.text, { parse_mode: "HTML", reply_markup: home.menu, link_preview_options: { is_disabled: true } });
    else await ctx.reply("Create a wallet first with /start.");
    return;
  }
  if (action.startsWith("guide:")) {
    const key = action.slice("guide:".length);
    await ctx.reply(GUIDES[key] ?? "Type what you want in plain language.", { parse_mode: "HTML" });
    return;
  }
}

export function helpText(): string {
  return (
    `${b("How to use Mezo Agent")}\n\n` +
    `Just type what you want — I turn it into a simulated, confirmable transaction:\n` +
    `• swap 100 MUSD to mUSDC\n• borrow 2000 MUSD against 0.1 BTC\n` +
    `• zap 0.01 BTC into BTC/MUSD · stake LP BTC/MUSD\n` +
    `• lock 0.2 BTC for 28 days · vote optimally with veNFT 3 · claim all\n` +
    `• dca 50 MUSD to BTC every 24h · auto-compound on\n\n` +
    `${b("Commands")}: /portfolio /deposit /limits /referral /export /upgrade /accounts /dca /fees /pause /diag\n\n` +
    i("Every fund-moving action is simulated and shown for confirmation before it signs.") +
    "\n" + i("Set spending caps with /limits; go read-only with /watch on.")
  );
}
