import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { createWallet, getUser, importWallet, InvalidPrivateKeyError } from "../../wallet/walletService.js";
import { explorerAddressUrl } from "../../chain/networks.js";
import { setPending, getPending, clearPending } from "../session.js";
import { b, i, code, link, esc } from "../format.js";

const netLabel = env.network === "mainnet" ? "🟢 MAINNET" : "🧪 TESTNET";

export async function handleStart(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const existing = getUser(telegramId);

  if (existing) {
    await ctx.reply(
      `Welcome back. You're on ${netLabel}.\n\n` +
        `Your account:\n${code(existing.address)}\n\n` +
        `Try:\n• /portfolio — balances\n• /deposit — fund with a QR code\n• "swap 100 MUSD to mUSDC"`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const kb = new InlineKeyboard()
    .text("🆕 Create a new wallet", "wallet:create")
    .row()
    .text("📥 Import existing (advanced)", "wallet:import");

  await ctx.reply(
    `👋 ${b("Mezo Agent")} — operate the Mezo Bitcoin-DeFi stack in plain language.\n\n` +
      `Network: ${netLabel}\n\n` +
      `To begin, create a fresh in-bot wallet, or import an existing account.\n\n` +
      i(
        "Note: this Phase-1 build uses a contained-custodial account (key encrypted at rest). " +
          "The production trust model is non-custodial, scoped session keys — see the README.",
      ),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function handleCreate(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  // Acknowledge the tap immediately so Telegram stops the button "loading" spinner,
  // even if wallet creation below is slow.
  await ctx.answerCallbackQuery().catch(() => {});

  if (getUser(telegramId)) {
    await ctx.reply("You already have an account. Use /portfolio or /deposit.");
    return;
  }

  // If creation fails, the error boundary surfaces it in-chat — never silent.
  const user = await createWallet(telegramId);

  await ctx.reply(
    `✅ ${b("Wallet created.")}\n\n` +
      `Your address:\n${code(user.address)}\n\n` +
      `${link("View on explorer", explorerAddressUrl(env.network, user.address))}\n\n` +
      `Fund it with /deposit, then check /portfolio.\n\n` +
      `🔒 Your key is encrypted at rest and never logged or shared with any AI model.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleImportPrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});

  setPending(telegramId, { kind: "import-await" });
  await ctx.reply(
    `⚠️ ${b("Importing a raw private key is the advanced, higher-risk path.")}\n\n` +
      `Only do this with a throwaway/testnet key. Paste your 0x private key in the next message.\n` +
      `It will be ${b("encrypted immediately")} and never logged or sent to any AI model.\n\n` +
      `Send /cancel to abort.`,
    { parse_mode: "HTML" },
  );
}

/** Handles the follow-up message containing a pasted private key. */
export async function maybeHandleImportKey(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!telegramId || !text) return false;
  const p = getPending(telegramId);
  if (!p || p.kind !== "import-await") return false;

  clearPending(telegramId);
  // Delete the message containing the secret as fast as possible.
  await ctx.deleteMessage().catch(() => {});

  try {
    const user = await importWallet(telegramId, text.trim());
    await ctx.reply(
      `✅ ${b("Account imported")} (your key message was deleted).\n\n` +
        `${code(user.address)}\n\nUse /portfolio or /deposit.`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    if (err instanceof InvalidPrivateKeyError) {
      await ctx.reply(`❌ ${esc(err.message)} Import aborted. Nothing was stored.`);
    } else {
      await ctx.reply("❌ Import failed. Nothing was stored.");
    }
  }
  return true;
}
