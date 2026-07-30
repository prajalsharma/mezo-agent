import { InlineKeyboard, type Bot } from "grammy";
import { formatUnits } from "viem";
import { env, feesEnabled } from "../config/env.js";
import { getUser, listAccounts, activeIndex } from "../wallet/walletService.js";
import { getPortfolio, prettyAmount } from "../portfolio/portfolioService.js";
import { registry } from "../registry/registry.js";
import { b, i, code } from "./format.js";

/**
 * Navigation. Modeled on the pattern shared by every well-regarded Telegram
 * trading bot (Trojan, Maestro, BONKbot, Banana Gun, GMGN): ONE home card with a
 * grouped button grid, each button opening a real submenu that is EDITED IN
 * PLACE, with consistent "‹ Back / 🏠 Menu" chrome. Slash commands mirror the
 * home tiles. Amount-based actions show a copy-paste example and rely on natural-
 * language typing (this bot's core input model); parameter-free actions (claim,
 * close, auto-compound, DCA list, new account) are real action buttons.
 */

const netLabel = env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet";

export type Card = { text: string; keyboard: InlineKeyboard };

/** The persistent home-screen button grid. Every feature is ≤2 taps away. */
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💼 Portfolio", "menu:nav:portfolio").text("💱 Swap", "menu:nav:swap")
    .row()
    .text("🏦 Borrow", "menu:nav:borrow").text("🌱 Earn", "menu:nav:earn")
    .row()
    .text("🔒 Lock & Vote", "menu:nav:lockvote").text("⚡ Automate", "menu:nav:automate")
    .row()
    .text("📥 Deposit", "menu:act:deposit").text("👥 Accounts", "menu:nav:accounts")
    .row()
    .text("⚙️ Settings", "menu:nav:settings").text("❓ Help", "menu:nav:help");
}

/** The wallet+balance "home" card shown on /start (returning user) and Menu. */
export async function homeCard(telegramId: number): Promise<{ text: string; menu: InlineKeyboard } | undefined> {
  const user = getUser(telegramId);
  if (!user) return undefined;
  let balLine = "";
  try {
    const holdings = await getPortfolio(user.address);
    const nonzero = holdings.filter((h) => Number(h.formatted) > 0);
    balLine = nonzero.length
      ? nonzero.map((h) => `• ${b(h.token.symbol)}: ${prettyAmount(h.formatted)}`).join("\n")
      : i("No balance yet — tap Deposit to fund your wallet.");
  } catch {
    balLine = i("(couldn't read balances just now — tap Refresh)");
  }
  const text =
    `${b(`Mezo Agent — ${netLabel}`)}\n${code(user.address)}\n\n` +
    `${balLine}\n\n` +
    i("Tap a button, or just type what you want — e.g. \"swap 100 MUSD to mUSDC\".");
  return { text, menu: mainMenu() };
}

/** Chrome: a bottom row that returns to a parent screen and/or the home menu. */
function chrome(kb: InlineKeyboard, backTo?: string): InlineKeyboard {
  kb.row();
  if (backTo) kb.text("‹ Back", `menu:nav:${backTo}`);
  kb.text("🏠 Menu", "menu:home");
  return kb;
}

// ── Submenu cards ────────────────────────────────────────────────────────────

function noWalletCard(): Card {
  return { text: `${b("No wallet yet")}\n\n${i("Send /start to create or import one.")}`, keyboard: new InlineKeyboard() };
}

async function portfolioCard(telegramId: number): Promise<Card> {
  const user = getUser(telegramId);
  if (!user) return noWalletCard();
  let body = "";
  try {
    const holdings = await getPortfolio(user.address);
    const nonzero = holdings.filter((h) => Number(h.formatted) > 0);
    body = nonzero.length
      ? nonzero.map((h) => `• ${b(h.token.symbol)}: ${prettyAmount(h.formatted)}`).join("\n")
      : i("No balance yet — tap Deposit to fund your wallet.");
  } catch {
    body = i("(couldn't read balances just now — tap Refresh)");
  }
  const kb = new InlineKeyboard()
    .text("🔄 Refresh", "menu:nav:portfolio").text("🌾 Claim rewards", "menu:do:claim");
  return {
    text: `${b("💼 Portfolio")}\n${code(user.address)}\n\n${body}\n\n` +
      i("Trove, LP & veNFT positions appear here as you open them."),
    keyboard: chrome(kb),
  };
}

async function accountsCard(telegramId: number): Promise<Card> {
  if (!getUser(telegramId)) return noWalletCard();
  const accounts = listAccounts(telegramId);
  const active = activeIndex(telegramId);
  const list = accounts.length
    ? accounts.map((a, idx) => `${idx === active ? "●" : "○"} ${b(`#${idx}`)} ${code(a.address)}`).join("\n")
    : i("No accounts yet.");
  const kb = new InlineKeyboard()
    .text("➕ New account", "menu:do:newaccount").text("🔀 Switch", "menu:tip:switch")
    .row()
    .text("🔑 Export key ⚠️", "menu:tip:export");
  return {
    text: `${b("👥 Accounts")}\n\n${list}\n\n${i("The ● is your active account. Deposits & actions use it.")}`,
    keyboard: chrome(kb),
  };
}

function settingsCard(): Card {
  const kb = new InlineKeyboard()
    .text("⚙️ Limits", "menu:act:limits").text("💸 Fees", "menu:act:fees")
    .row()
    .text("🎁 Referral", "menu:act:referral").text("🔐 Upgrade", "menu:tip:upgrade");
  return {
    text: `${b("⚙️ Settings")}\n\n` +
      `• ${b("Limits")} — spending caps & watch-only mode\n` +
      `• ${b("Fees")} — what the agent charges (and gas)\n` +
      `• ${b("Referral")} — your link & rewards\n` +
      `• ${b("Upgrade")} — EIP-7702 scoped smart account`,
    keyboard: chrome(kb),
  };
}

// ── Swap picker flow: source token → destination → preset amount ─────────────
// Sniper-bot-style tap-to-swap. Amounts are % of the on-chain balance; the
// existing quote/confirm card takes over once an amount is chosen.

const NATIVE_GAS_BUFFER_WEI = 500_000_000_000_000n; // 0.0005 BTC kept for gas on Max

/** Step 1 — pick the token to sell (from non-zero balances). */
async function swapFromCard(telegramId: number): Promise<Card> {
  const user = getUser(telegramId);
  if (!user) return noWalletCard();
  let nonzero: Awaited<ReturnType<typeof getPortfolio>> = [];
  try { nonzero = (await getPortfolio(user.address)).filter((h) => h.raw > 0n); } catch { /* empty */ }
  const kb = new InlineKeyboard();
  nonzero.forEach((h, idx) => {
    kb.text(`${h.token.symbol} · ${prettyAmount(h.formatted)}`, `menu:swapfrom:${h.token.symbol}`);
    if (idx % 2 === 1) kb.row();
  });
  if (nonzero.length % 2 === 1) kb.row();
  const text = nonzero.length
    ? `${b("💱 Swap — pick the token to sell:")}\n\n${i("Or just type it, e.g. \"swap 100 MUSD to mUSDC\".")}`
    : `${b("💱 Swap")}\n\n${i("No balance to swap yet — tap Deposit to fund your wallet, then come back.")}`;
  return { text, keyboard: chrome(kb) };
}

/** Token symbols that share a live pool with `from`. */
function swapDestinations(from: string): string[] {
  const dests = new Set<string>();
  for (const p of registry.pools()) {
    const [a, c] = p.pair;
    if (a === from) dests.add(c);
    else if (c === from) dests.add(a);
  }
  return [...dests];
}

/** Step 2 — pick what to buy (only tokens with a direct pool). */
export function swapToCard(from: string): Card {
  const dests = swapDestinations(from);
  const kb = new InlineKeyboard();
  dests.forEach((d, idx) => { kb.text(d, `menu:swapto:${from}:${d}`); if (idx % 2 === 1) kb.row(); });
  if (dests.length % 2 === 1) kb.row();
  const text = dests.length
    ? `${b(`💱 Swap ${from} → pick what to buy:`)}`
    : `${b(`💱 Swap ${from}`)}\n\n${i(`No direct pool from ${from} yet. Try a different token.`)}`;
  return { text, keyboard: chrome(kb, "swap") };
}

/** Step 3 — pick a preset amount (% of balance) or type a custom one. */
export async function swapAmountCard(from: string, to: string, telegramId: number): Promise<Card> {
  const user = getUser(telegramId);
  let bal = "—";
  // A realistic custom-amount example derived from the ACTUAL balance (25%), so
  // it never suggests an amount the user doesn't have (e.g. "swap 12.5 BTC").
  let example = from === "BTC" ? "0.01" : "100";
  if (user) {
    try {
      const h = (await getPortfolio(user.address)).find((x) => x.token.symbol === from);
      if (h && h.raw > 0n) {
        bal = prettyAmount(h.formatted);
        const quarter = prettyAmount(formatUnits(h.raw / 4n, h.token.decimals));
        if (quarter && quarter !== "0") example = quarter;
      }
    } catch { /* keep defaults */ }
  }
  const kb = new InlineKeyboard()
    .text("25%", `menu:swapx:${from}:${to}:25`)
    .text("50%", `menu:swapx:${from}:${to}:50`)
    .text("Max", `menu:swapx:${from}:${to}:100`);
  const text =
    `${b(`💱 Swap ${from} → ${to}`)}\nYour ${from}: ${b(bal)}\n\n` +
    `Pick an amount above, or type a custom one:\n${code(`swap ${example} ${from} to ${to}`)}`;
  return { text, keyboard: chrome(kb, "swap") };
}

/** Resolve a preset (% of balance) into a human amount string for handleSwapIntent. */
export async function presetSwapAmount(telegramId: number, from: string, pct: number): Promise<string | undefined> {
  const user = getUser(telegramId);
  const tok = registry.tryToken(from);
  if (!user || !tok) return undefined;
  let raw = 0n;
  try { raw = (await getPortfolio(user.address)).find((x) => x.token.symbol === from)?.raw ?? 0n; } catch { return undefined; }
  if (raw <= 0n) return undefined;
  let amt = (raw * BigInt(pct)) / 100n;
  // Native BTC pays gas — on "Max" leave a buffer so the swap can still be sent.
  if (tok.native && pct >= 100) amt = raw > NATIVE_GAS_BUFFER_WEI ? raw - NATIVE_GAS_BUFFER_WEI : 0n;
  if (amt <= 0n) return undefined;
  return formatUnits(amt, tok.decimals);
}

function borrowCard(): Card {
  const kb = new InlineKeyboard()
    .text("➕ Open Trove", "menu:tip:borrow_open").text("💵 Repay", "menu:tip:borrow_repay")
    .row()
    .text("🔧 Adjust", "menu:tip:borrow_adjust").text("🔒 Close ⚠️", "menu:do:closeTrove");
  return {
    text: `${b("🏦 Borrow — MUSD against BTC")}\n\n` +
      `Deposit BTC as collateral and mint MUSD.\n` +
      i("Min debt 1,800 MUSD; keep your collateral ratio above 110% or risk liquidation. The live ratio is shown before you confirm."),
    keyboard: chrome(kb),
  };
}

function earnCard(): Card {
  const kb = new InlineKeyboard()
    .text("🌊 Stake LP", "menu:tip:earn_stake").text("🏛️ Vault", "menu:tip:earn_vault")
    .row()
    .text("⚡ Zap in", "menu:tip:earn_zap").text("🌾 Claim", "menu:do:claim");
  return {
    text: `${b("🌱 Earn — yield on your assets")}\n\n` +
      `Provide liquidity, deposit into a vault, or zap one asset straight into an LP position.`,
    keyboard: chrome(kb),
  };
}

function lockVoteCard(): Card {
  const kb = new InlineKeyboard()
    .text("🔒 Lock", "menu:tip:lock").text("⏫ Extend", "menu:tip:extendlock")
    .row()
    .text("🗳️ Vote", "menu:tip:vote").text("🌾 Claim", "menu:do:claim");
  return {
    text: `${b("🔒 Lock & Vote — veBTC / veMEZO")}\n\n` +
      `Lock BTC or MEZO for voting power, then direct emissions to pools.\n` +
      i("\"vote optimally\" runs the transparent water-filling allocator over live incentives."),
    keyboard: chrome(kb),
  };
}

function automateCard(): Card {
  const kb = new InlineKeyboard()
    .text("📋 My DCA", "menu:do:dcalist").text("➕ New DCA", "menu:tip:dca")
    .row()
    .text("♻️ Auto-compound ON", "menu:do:autocompound_on").text("⏹️ OFF", "menu:do:autocompound_off");
  return {
    text: `${b("⚡ Automate")}\n\n` +
      `• ${b("DCA")} — buy a fixed amount on a repeating schedule\n` +
      `• ${b("Auto-compound")} — claim & reinvest rewards each epoch\n\n` +
      i("Each automated run is scoped by your spending limits and can be paused any time (/pause)."),
    keyboard: chrome(kb),
  };
}

/** Build a submenu card by name. Returns undefined for unknown screens. */
export async function screenCard(screen: string, telegramId: number): Promise<Card | undefined> {
  switch (screen) {
    case "portfolio": return portfolioCard(telegramId);
    case "swap": return swapFromCard(telegramId);
    case "borrow": return borrowCard();
    case "earn": return earnCard();
    case "lockvote": return lockVoteCard();
    case "automate": return automateCard();
    case "accounts": return accountsCard(telegramId);
    case "settings": return settingsCard();
    case "help": return { text: helpText(), keyboard: chrome(new InlineKeyboard()) };
    default: return undefined;
  }
}

// ── Tip (guidance) sub-cards for parameterized actions ───────────────────────

const TIPS: Record<string, { parent: string; text: string }> = {
  borrow_open: { parent: "borrow", text: `${b("➕ Open Trove")}\nType, e.g.:\n${code("borrow 2000 MUSD against 0.1 BTC")}\n\n${i("You'll see the live collateral ratio and confirm before signing.")}` },
  borrow_repay: { parent: "borrow", text: `${b("💵 Repay")}\nType:\n${code("repay 500 MUSD")}` },
  borrow_adjust: { parent: "borrow", text: `${b("🔧 Adjust Trove")}\nType any of:\n${code("add 0.05 BTC collateral")}\n${code("withdraw 0.02 BTC")}\n${code("mint 500 MUSD")}` },
  earn_stake: { parent: "earn", text: `${b("🌊 Stake LP")}\nType:\n${code("stake LP BTC/MUSD")}` },
  earn_vault: { parent: "earn", text: `${b("🏛️ Vault deposit")}\nType:\n${code("deposit 100 MUSD into vault")}` },
  earn_zap: { parent: "earn", text: `${b("⚡ Zap into a pool")}\nType:\n${code("zap 0.01 BTC into BTC/MUSD")}\n\n${i("Splits one asset into an LP position in a single flow.")}` },
  lock: { parent: "lockvote", text: `${b("🔒 Lock")}\nType:\n${code("lock 0.2 BTC for 28 days")}\n${code("lock 1000 MEZO for 2 years")}` },
  extendlock: { parent: "lockvote", text: `${b("⏫ Extend a lock")}\nType:\n${code("extend lock 3 by 30 days")}` },
  vote: { parent: "lockvote", text: `${b("🗳️ Vote")}\nType:\n${code("vote optimally with veNFT 3")}\n${code("vote with veNFT 3: 60% BTC/MUSD, 40% MUSD/mUSDC")}` },
  dca: { parent: "automate", text: `${b("➕ New DCA schedule")}\nType:\n${code("dca 50 MUSD to BTC every 24h")}\n${code("dca 100 MUSD to mUSDC every 7 days for 4 times")}` },
  switch: { parent: "accounts", text: `${b("🔀 Switch account")}\nType:\n${code("switch to account 2")}\n\n${i("Indices are shown in the account list.")}` },
  export: { parent: "accounts", text: `${b("🔑 Export private key")}\n${i("This reveals your key — anyone who sees it controls your funds. Only in a private chat.")}\n\nSend ${code("/export")} to start the guarded reveal.` },
  upgrade: { parent: "settings", text: `${b("🔐 Smart-account upgrade (EIP-7702)")}\n${i("A scoped, revocable session key signs routine ops within on-chain caps, so your root key stays cold.")}\n\nSend ${code("/upgrade")} to enable it.` },
};

/** Build a tip/guidance sub-card by key. */
export function tipCard(key: string): Card | undefined {
  const t = TIPS[key];
  if (!t) return undefined;
  return { text: t.text, keyboard: chrome(new InlineKeyboard(), t.parent) };
}

/** Fee disclosure text — shared by /fees and the Settings → Fees card. */
export function feesText(): string {
  const lines = [b("💸 Fees"), ""];
  if (feesEnabled) {
    lines.push(
      `• Swaps & zaps: ${b(`${env.fees.swapBps / 100}%`)} of the input amount, taken in the input token.`,
      ...(env.fees.txnBps > 0 ? [`• Borrow / vault deposit / lock: ${b(`${env.fees.txnBps / 100}%`)} of the amount, taken in that token.`] : []),
      `• Shown on every confirmation before you approve — you always see the exact amount.`,
      `• Fee recipient: ${code(env.fees.recipient)}`,
      `• Referral share: ${b(`${env.fees.referralSharePct}%`)} of the fee goes to whoever referred the trader (/referral).`,
    );
  } else {
    lines.push("• No agent fee is currently charged on this deployment.");
  }
  if (env.fees.automationNote) lines.push(`• Automation (DCA / auto-compound): ${env.fees.automationNote}`);
  lines.push("", i("Network gas (BTC) is paid by you and is separate from any agent fee."));
  return lines.join("\n");
}

/** How-to / help card body. */
export function helpText(): string {
  return (
    `${b("❓ How to use Mezo Agent")}\n\n` +
    `Tap a menu button, or just type what you want — I turn it into a simulated, confirmable transaction:\n` +
    `• swap 100 MUSD to mUSDC\n• borrow 2000 MUSD against 0.1 BTC\n` +
    `• zap 0.01 BTC into BTC/MUSD · stake LP BTC/MUSD\n` +
    `• lock 0.2 BTC for 28 days · vote optimally with veNFT 3 · claim all\n` +
    `• dca 50 MUSD to BTC every 24h · auto-compound on\n\n` +
    i("Every fund-moving action is simulated and shown for confirmation before it signs. Set spending caps in Settings → Limits.")
  );
}

/**
 * Register the slash-command menu + profile description at startup. The command
 * list MIRRORS the home tiles (plus a few utilities), so buttons and commands
 * finally cover the same features.
 */
export async function installBotProfile(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "🏠 Home — wallet, balances, menu" },
    { command: "portfolio", description: "💼 Balances & positions" },
    { command: "swap", description: "💱 Swap tokens" },
    { command: "borrow", description: "🏦 Borrow MUSD against BTC" },
    { command: "earn", description: "🌱 LP, vaults, zap, claim" },
    { command: "vote", description: "🔒 Lock & vote (veBTC)" },
    { command: "automate", description: "⚡ DCA & auto-compound" },
    { command: "deposit", description: "📥 Deposit address + QR" },
    { command: "accounts", description: "👥 Manage wallets" },
    { command: "settings", description: "⚙️ Limits, fees, referral, upgrade" },
    { command: "fees", description: "💸 Fee disclosure" },
    { command: "help", description: "❓ How to use the bot" },
    { command: "pause", description: "🛑 Emergency stop automation" },
    { command: "diag", description: "🩺 Health self-test" },
  ]).catch(() => {});

  await bot.api.setMyShortDescription(
    "Operate the full Mezo Bitcoin-DeFi stack in plain language — borrow, swap, earn, lock & vote. Non-custodial, every action confirmed.",
  ).catch(() => {});

  await bot.api.setMyDescription(
    "Mezo Agent turns plain-English messages into safe, simulated Mezo transactions.\n\n" +
      "• Borrow MUSD against BTC, swap, zap into pools, stake LP, lock veBTC & vote\n" +
      "• Every fund-moving action is simulated and shown for confirmation before signing\n" +
      "• Spending limits, watch-only mode, and an emergency pause built in\n\n" +
      "Tap Start to create or import a wallet.",
  ).catch(() => {});
}
