import { type Context, InputFile } from "grammy";
import QRCode from "qrcode";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { getPortfolio, prettyAmount } from "../../portfolio/portfolioService.js";
import { explorerAddressUrl } from "../../chain/networks.js";

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
    .map((h) => `• *${h.token.symbol}*: ${prettyAmount(h.formatted)}`)
    .join("\n");

  await ctx.reply(
    `*Portfolio* — ${netLabel}\n\`${user.address}\`\n\n${lines}\n\n` +
      `_Positions coming in later phases: Troves, LP, veNFTs, claimable rewards._`,
    { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
  );
}

export async function handleDeposit(ctx: Context): Promise<void> {
  const user = await requireUser(ctx);
  if (!user) return;

  const png = await QRCode.toBuffer(user.address, { width: 512, margin: 2 });
  await ctx.replyWithPhoto(new InputFile(png, "deposit.png"), {
    caption:
      `*Deposit address* — ${netLabel}\n\`${user.address}\`\n\n` +
      `Send BTC (native gas asset) or any Mezo token to this address.\n` +
      `[View on explorer](${explorerAddressUrl(env.network, user.address)})`,
    parse_mode: "Markdown",
  });
}
