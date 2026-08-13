import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { env } from "../../config/env.js";
import { createWallet, exportPrivateKey, getUser, importWallet, WalletImportError } from "../../wallet/walletService.js";
import { explorerAddressUrl } from "../../chain/networks.js";
import { setPending, getPending, clearPending } from "../session.js";
import { store } from "../../db/store.js";
import { mainMenu, homeCard } from "../menu.js";
import { b, i, code, link, esc } from "../format.js";

const netLabel = env.network === "mainnet" ? "🟢 MAINNET" : "🧪 TESTNET";

export async function handleStart(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Deep-link referral capture: t.me/<bot>?start=<referrerId>. Recorded only
  // for a genuinely new user, never self-referral. (Attribution primitive; the
  // fee revenue-share is disclosed via /referral and /fees.)
  const payload = (ctx.match as string | undefined)?.trim();
  const pendingRef = payload && /^\d+$/.test(payload) && Number(payload) !== telegramId
    ? Number(payload)
    : undefined;

  const existing = getUser(telegramId);
  if (existing) {
    const home = await homeCard(telegramId);
    if (home) { await ctx.reply(home.text, { parse_mode: "HTML", reply_markup: home.menu, link_preview_options: { is_disabled: true } }); return; }
  }

  if (pendingRef !== undefined) rememberPendingReferral(telegramId, pendingRef);

  const kb = new InlineKeyboard()
    .text("🆕 Create a new wallet", "wallet:create")
    .row()
    .text("📥 Import existing (advanced)", "wallet:import");

  await ctx.reply(
    `👋 ${b("Mezo Agent")} - operate the Mezo Bitcoin-DeFi stack in plain language.\n\n` +
      `Network: ${netLabel}\n\n` +
      (pendingRef !== undefined ? i(`🎁 Referred by a friend - you're both set up for referral rewards.`) + "\n\n" : "") +
      `Borrow · Swap · Zap · Stake · Lock & Vote - all in chat, every action confirmed.\n\n` +
      i("🔒 Keys are encrypted, never shown in chat, and every transaction needs your explicit confirmation. Set spending caps anytime with /limits."),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

/**
 * Pending referral (referrer id) until the wallet is created. PERSISTED in the
 * datastore (24h TTL) so a redeploy/crash between the /start click and wallet
 * creation can't silently drop a credit the user was already promised. Entries
 * expire so an abandoned onboarding can't grow the store — Audit R3 F3.
 */
const REFERRAL_TTL_MS = 24 * 60 * 60 * 1000;
function rememberPendingReferral(newUser: number, referrer: number): void {
  store.setPendingReferral(newUser, referrer, REFERRAL_TTL_MS);
}

/**
 * Attribute a pending referral onto a just-created/imported account.
 * Validate-BEFORE-consume: the pending entry is only cleared once the credit
 * actually lands (or is definitively invalid), so a transient store hiccup
 * can't destroy an unclaimable-but-valid credit.
 */
export function attributeReferral(telegramId: number): void {
  const referrer = store.peekPendingReferral(telegramId);
  if (referrer === undefined) return;
  const rec = getUser(telegramId);
  if (!rec) return; // wallet not created yet — keep the entry for the next attempt
  const refRec = getUser(referrer);
  // Never credit: a non-existent referrer, an existing attribution, or a
  // "referrer" whose wallet IS this wallet (same key imported on a second
  // Telegram account — the cheap self-referral loophole).
  if (rec.referredBy === undefined && refRec && refRec.address.toLowerCase() !== rec.address.toLowerCase()) {
    rec.referredBy = referrer;
    store.saveUser(rec);
  }
  store.clearPendingReferral(telegramId);
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

  // Attribute a pending deep-link referral now that the account exists.
  attributeReferral(telegramId);

  // Points at /export rather than arming a reveal button directly. A live
  // "reveal my key" button sitting in the wallet-creation card stays tappable
  // forever, so anyone with a moment of access to an unlocked session could
  // scroll back and dump the key with one tap and no second step.
  const kb = new InlineKeyboard()
    .text("🔐 How to back up my key", "menu:tip:export")
    .row()
    .text("📥 Deposit", "menu:deposit").text("📊 Portfolio", "menu:portfolio");
  await ctx.reply(
    `✅ ${b("Wallet created.")}\n\n` +
      `Your address:\n${code(user.address)}\n\n` +
      `${link("View on explorer", explorerAddressUrl(env.network, user.address))}\n\n` +
      `⚠️ ${b("Back up your key now")} - tap below or run /export and save it somewhere safe. ` +
      `Your key lives only on this bot's server; backing it up is the ONLY way to recover this wallet if anything happens to the host.\n\n` +
      `🔒 It's encrypted at rest and never logged or sent to any AI model.\n\n` +
      `Then fund it with /deposit.`,
    { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } },
  );
}

export async function handleImportPrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  await ctx.answerCallbackQuery().catch(() => {});

  setPending(telegramId, { kind: "import-await" });
  await ctx.reply(
    `⚠️ ${b("Importing a raw secret is the advanced, higher-risk path.")}\n\n` +
      `Prefer an account you can afford to lose, and never your main savings. In the next message paste either:\n` +
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
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("No account yet - create one with /start first.");
    return;
  }
  // SINGLE-USE, SHORT-LIVED token in the callback data.
  //
  // "wallet:export-confirm" used to be a constant string with no pending state,
  // no TTL and no second factor, so EVERY export card the user had ever seen
  // stayed armed forever — one tap on any of them dumped the key.
  const token = armExport(telegramId, user.address);
  const kb = new InlineKeyboard()
    .text("🔓 Yes, reveal my key", `wallet:export-confirm:${token}`)
    .row()
    .text("Cancel", `wallet:export-cancel:${token}`);
  await ctx.reply(
    `⚠️ ${b("Export private key?")}\n\n` +
      `Anyone who sees this key ${b("fully controls your funds")} - no confirmation, no limits, nothing this bot enforces applies to them.\n\n` +
      `• This prompt is valid for ${b("2 minutes")} and works ${b("once")}. After that, run /export again.\n` +
      `• I will TRY to delete the key message after 60 seconds, but treat that as a courtesy, not a guarantee: ` +
      `if the bot restarts, or Telegram refuses the delete, ${b("the key stays in this chat until you delete it")}.\n` +
      `• Telegram chat history syncs to every device you're logged in on.\n` +
      `• Best done in private, then imported straight into MetaMask/Rabby.\n\n` +
      `${i("Note: in-bot wallets are raw keys - there is no 12-word phrase to show. A seed phrase only exists for accounts you imported FROM a phrase.")}`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

/**
 * Pending export authorisations: one per user, single-use, short-lived, and
 * bound to the account that was active when /export was typed.
 */
const EXPORT_TTL_MS = 2 * 60 * 1000;
const pendingExport = new Map<number, { token: string; address: string; expiresAt: number }>();

function armExport(telegramId: number, address: string): string {
  const token = randomBytes(9).toString("base64url");
  pendingExport.set(telegramId, { token, address, expiresAt: Date.now() + EXPORT_TTL_MS });
  return token;
}

/** Claim the authorisation for `token`, consuming it. Synchronous, no awaits. */
function takeExport(telegramId: number, token: string): { address: string } | undefined {
  const p = pendingExport.get(telegramId);
  if (!p) return undefined;
  if (Date.now() > p.expiresAt || p.token !== token) {
    pendingExport.delete(telegramId);
    return undefined;
  }
  pendingExport.delete(telegramId);
  return { address: p.address };
}

function callbackToken(ctx: Context): string {
  return (ctx.callbackQuery?.data ?? "").split(":")[2] ?? "";
}

export async function handleExportConfirm(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  // Consume the authorisation BEFORE any await, so a stale card and a
  // double-tap both fail rather than revealing the key twice.
  const authorised = takeExport(telegramId, callbackToken(ctx));
  await ctx.answerCallbackQuery().catch(() => {});
  // Remove the warning/buttons so the flow can't be re-triggered from an old card.
  await ctx.deleteMessage().catch(() => {});

  if (!authorised) {
    await ctx.reply("That export prompt has expired or was already used. Nothing was revealed - run /export again if you still want the key.");
    return;
  }
  // The active account can be switched between typing /export and tapping
  // confirm; revealing a different account's key than the one warned about is
  // never what was intended.
  const current = getUser(telegramId);
  if (!current || current.address.toLowerCase() !== authorised.address.toLowerCase()) {
    await ctx.reply("You switched active account since starting that export, so I revealed nothing. Run /export again.");
    return;
  }

  try {
    const key = await exportPrivateKey(telegramId);
    const sent = await ctx.reply(
      `🔑 ${b("Your private key")}:\n\n${code(key)}\n\n` +
        `${b("Delete this message yourself once you've saved it.")} I'll also try to remove it in 60 seconds, ` +
        `but that's best-effort - it won't happen if the bot restarts first.`,
      { parse_mode: "HTML" },
    );
    // Self-destruct. Best-effort, and the copy above says so rather than
    // promising an "auto-delete" that an in-process timer cannot guarantee.
    setTimeout(() => {
      ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {});
    }, 60_000);
  } catch (err) {
    await ctx.reply(`❌ ${esc(err instanceof Error ? err.message : "Export failed.")}`);
  }
}

export async function handleExportCancel(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId) takeExport(telegramId, callbackToken(ctx));
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

  // Raw private key: a 64-hex run ANYWHERE (not just as the whole message), so
  // "import my key 0x<64hex>" is caught too. This bot never legitimately takes a
  // pasted 64-hex value, so over-matching (e.g. a tx hash) is a safe refusal.
  if (/\b(?:0x)?[0-9a-fA-F]{64}\b/.test(t)) return true;

  // Seed phrase: normalize first (lowercase, drop list-numbers like "1." / "2)"
  // and punctuation), then flag any run of ≥12 consecutive alphabetic 3–8-char
  // tokens. This catches capitalized ("Abandon abandon …"), numbered, and
  // sentence-embedded phrases the old all-lowercase whole-message test missed.
  // (Audit R3 — hardening the R2/C3 no-secret-to-LLM guarantee.)
  const norm = t.toLowerCase().replace(/\d+\s*[.):-]/g, " ").replace(/[^a-z\s]/g, " ");
  let run = 0;
  for (const w of norm.split(/\s+/)) {
    if (/^[a-z]{3,8}$/.test(w)) {
      if (++run >= 12) return true;
    } else {
      run = 0;
    }
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
    attributeReferral(telegramId); // referral works via import too, not just Create
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
