import { type Context, InputFile, InlineKeyboard } from "grammy";
import QRCode from "qrcode";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { getPortfolio, prettyAmount } from "../../portfolio/portfolioService.js";
import { explorerAddressUrl } from "../../chain/networks.js";
import { b, i, code, link } from "../format.js";
import { positionsBlock } from "../positionsView.js";
import { faucetButton, faucetHint } from "../faucet.js";

const netLabel = env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet";

async function requireUser(ctx: Context) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return undefined;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start to create one.");
    return undefined;
  }
  return user;
}

export async function handlePortfolio(ctx: Context): Promise<void> {
  const user = await requireUser(ctx);
  if (!user) return;

  await ctx.reply("📊 Reading your balances…");
  const holdings = await getPortfolio(user.address);

  const lines = holdings
    .map((h) => `• ${b(h.token.symbol)}: ${prettyAmount(h.formatted)}`)
    .join("\n");

  await ctx.reply(
    `${b(`Portfolio - ${netLabel}`)}\n${code(user.address)}\n\n${lines}\n\n${await positionsBlock(user.address)}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleDeposit(ctx: Context): Promise<void> {
  const user = await requireUser(ctx);
  if (!user) return;

  const png = await QRCode.toBuffer(user.address, { width: 512, margin: 2 });
  // On testnet, offer the faucet as an in-Telegram web app (opens in the built-in
  // browser overlay — no leaving the chat) plus a 🏠 Menu button.
  const kb = new InlineKeyboard();
  const fb = faucetButton();
  if (fb) kb.webApp(fb.label, fb.url).row();
  kb.text("🏠 Menu", "menu:home");
  await ctx.replyWithPhoto(new InputFile(png, "deposit.png"), {
    caption:
      `${b(`Deposit address - ${netLabel}`)}\n${code(user.address)}\n\n` +
      `Send BTC (native gas asset) or any Mezo token to this address.\n` +
      (faucetHint() ? `${i(faucetHint()!)}\n` : "") +
      `${link("View on explorer", explorerAddressUrl(env.network, user.address))}`,
    parse_mode: "HTML",
    reply_markup: kb,
  });
}
