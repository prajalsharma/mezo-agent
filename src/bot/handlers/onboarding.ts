import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { createWallet, exportPrivateKey, getUser, importWallet, WalletImportError } from "../../wallet/walletService.js";
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
      i("🔒 Keys are encrypted, never shown in chat, and every transaction needs your explicit confirmation. Set spending caps anytime with /limits."),
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
      `🔒 Your key is encrypted at rest and never logged or shared with any AI model.\n` +
      `You stay in control: /export reveals your private key any time (for MetaMask etc.), behind an explicit warning.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

export async function handleImportPrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});

  setPending(telegramId, { kind: "import-await" });
  await ctx.reply(
    `⚠️ ${b("Importing a raw secret is the advanced, higher-risk path.")}\n\n` +
      `Only do this with a throwaway/testnet account. In the next message paste either:\n` +
      `• a ${b("private key")} (0x + 64 hex), or\n` +
      `• a ${b("seed phrase")} (12–24 words).\n\n` +
      `It will be ${b("encrypted immediately")}, and never logged or sent to any AI model.\n\n` +
      `Send /cancel to abort.`,
    { parse_mode: "HTML" },
  );
}

/**
 * /export — two-step, opt-in reveal of the active account's private key.
 *
 * Mirrors the bounty's raw-import standard in reverse: explicit opt-in, a
 * clear risk warning BEFORE anything is revealed, and no plaintext at rest.
 * The reveal message self-destructs after 60 seconds; Telegram chat history is
 * the exposure surface, so the key should live there as briefly as possible.
 */
export async function handleExportPrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  if (!getUser(telegramId)) {
    await ctx.reply("No account yet — create one with /start first.");
    return;
  }
  const kb = new InlineKeyboard()
    .text("🔓 Yes, reveal my key", "wallet:export-confirm")
    .row()
    .text("Cancel", "wallet:export-cancel");
  await ctx.reply(
    `⚠️ ${b("Export private key?")}\n\n` +
      `Anyone who sees this key ${b("fully controls your funds")} — no confirmation, no limits, nothing this bot enforces applies to them.\n\n` +
      `• It will appear in this chat for ${b("60 seconds")}, then auto-delete.\n` +
      `• Telegram chat history syncs to every device you're logged in on.\n` +
      `• Best done in private, then imported straight into MetaMask/Rabby.\n\n` +
      `${i("Note: in-bot wallets are raw keys — there is no 12-word phrase to show. A seed phrase only exists for accounts you imported FROM a phrase.")}`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function handleExportConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});
  // Remove the warning/buttons so the flow can't be re-triggered from an old card.
  await ctx.deleteMessage().catch(() => {});

  try {
    const key = await exportPrivateKey(telegramId);
    const sent = await ctx.reply(
      `🔑 ${b("Your private key")} (auto-deletes in 60s):\n\n${code(key)}\n\n` +
        `Import it into a wallet app now. Delete this message yourself once done.`,
      { parse_mode: "HTML" },
    );
    // Self-destruct. Best-effort: if the bot lacks delete rights the user was
    // told to delete it manually.
    setTimeout(() => {
      ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {});
    }, 60_000);
  } catch (err) {
    await ctx.reply(`❌ ${esc(err instanceof Error ? err.message : "Export failed.")}`);
  }
}

export async function handleExportCancel(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Export cancelled. Nothing was revealed.");
}

/**
 * Detect a private key or BIP-39 seed phrase by SHAPE, so such text can be
 * blocked before it ever reaches the LLM parser (Audit R2 C3). Deliberately
 * broad: a false positive just asks the user to rephrase; a false negative
 * leaks a secret to a third-party model.
 */
export function looksLikeSecret(text: string): boolean {
  const t = text.trim();
  // Private key: 64 hex chars, optional 0x.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return true;
  // Seed phrase: 12/15/18/21/24 lowercase alphabetic words.
  const words = t.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return true;
  }
  return false;
}

/** Handles the follow-up message containing a pasted private key. */
export async function maybeHandleImportKey(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!telegramId || !text) return false;
  const p = getPending(telegramId);
  if (!p || p.kind !== "import-await") return false;

  // Delete the message containing the secret as fast as possible. Do NOT clear
  // pending yet — if the import fails we re-arm so a corrected re-paste is still
  // consumed here and never falls through to the LLM (Audit R2 C3).
  await ctx.deleteMessage().catch(() => {});

  try {
    const user = await importWallet(telegramId, text.trim());
    clearPending(telegramId);
    await ctx.reply(
      `✅ ${b("Account imported")} (your key message was deleted).\n\n` +
        `${code(user.address)}\n\nUse /portfolio or /deposit.`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    // Re-arm: the next message is still treated as an import attempt.
    setPending(telegramId, { kind: "import-await" });
    if (err instanceof WalletImportError) {
      await ctx.reply(`❌ ${esc(err.message)} Nothing was stored. Paste again, or /cancel to stop.`);
    } else {
      await ctx.reply("❌ Import failed. Nothing was stored. Paste again, or /cancel to stop.");
    }
  }
  return true;
}
