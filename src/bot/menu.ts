import { InlineKeyboard, type Bot } from "grammy";
import { formatUnits, parseEther } from "viem";
import { env, feesEnabled } from "../config/env.js";
import { getUser, listAccounts, activeIndex } from "../wallet/walletService.js";
import { store } from "../db/store.js";
import { getPortfolio, prettyAmount } from "../portfolio/portfolioService.js";
import { registry } from "../registry/registry.js";
import { publicClient } from "../chain/client.js";
import { b, i, code } from "./format.js";
import { positionsBlock } from "./positionsView.js";
import { explainerList } from "./explainers.js";

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
      : i("No balance yet - tap Deposit to fund your wallet.");
  } catch {
    balLine = i("(couldn't read balances just now - tap Refresh)");
  }
  const text =
    `${b(`Mezo Agent - ${netLabel}`)}\n${code(user.address)}\n\n` +
    `${balLine}\n\n` +
    i(`Tap a button, or just type what you want - e.g. "${swapExample()}".`);
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
      : i("No balance yet - tap Deposit to fund your wallet.");
  } catch {
    body = i("(couldn't read balances just now - tap Refresh)");
  }
  const kb = new InlineKeyboard()
    .text("🔄 Refresh", "menu:nav:portfolio").text("🌾 Claim rewards", "menu:do:claim");
  return {
    text: `${b("💼 Portfolio")}\n${code(user.address)}\n\n${body}\n\n${await positionsBlock(user.address)}`,
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

/** 📚 Learn — every ELI5 explainer, browsable. Static hand-written content. */
function learnCard(): Card {
  const kb = new InlineKeyboard();
  explainerList().forEach((e, idx) => {
    kb.text(e.label, `menu:learn:${e.key}`);
    if (idx % 2 === 1) kb.row();
  });
  if (explainerList().length % 2 === 1) kb.row();
  return {
    text: `${b("📚 Learn - DeFi in plain English")}\n\n` +
      `Tap any topic for a short, jargon-free explanation:\n` +
      explainerList().map((e) => `• ${e.label.replace(/^\S+\s/, "")}`).join("\n") + "\n\n" +
      i("You can also just ask, e.g. \"what is liquidation?\". These are hand-written, never AI-generated."),
    keyboard: chrome(kb, "help"),
  };
}

function settingsCard(): Card {
  const kb = new InlineKeyboard()
    .text("⚙️ Limits", "menu:act:limits").text("💸 Fees", "menu:act:fees")
    .row()
    .text("🎁 Referral", "menu:act:referral").text("🔐 Upgrade", "menu:tip:upgrade");
  return {
    text: `${b("⚙️ Settings")}\n\n` +
      `• ${b("Limits")} - spending caps & watch-only mode\n` +
      `• ${b("Fees")} - what the agent charges (and gas)\n` +
      `• ${b("Referral")} - your link & rewards\n` +
      `• ${b("Upgrade")} - EIP-7702 scoped smart account`,
    keyboard: chrome(kb),
  };
}

// ── Live capability copy — built from the registry, never hardcoded ──────────
// Every example the bot shows must reflect what is ACTUALLY deployed on this
// network (pools, tokens, vaults), so users are never taught a command that
// can't work here.

/** A sensible example amount for a token symbol. */
function exAmt(sym: string): string {
  return sym.toUpperCase().includes("BTC") ? "0.01" : "100";
}

// Live pool-liquidity check (a registered pool can still be EMPTY — on testnet
// MUSD/mUSDT has zero reserves, so offering it as a route is a dead end). Reads
// getReserves per pool, cached for 60s; a read failure counts as live (fail
// open) so an RPC blip never hides a real route.
const RESERVES_ABI = [{
  type: "function", name: "getReserves", stateMutability: "view", inputs: [],
  outputs: [{ name: "_reserve0", type: "uint256" }, { name: "_reserve1", type: "uint256" }, { name: "_blockTimestampLast", type: "uint256" }],
}] as const;
let liquidityCache: { at: number; empty: Set<string> } | undefined;
async function emptyPoolAddresses(): Promise<Set<string>> {
  if (liquidityCache && Date.now() - liquidityCache.at < 60_000) return liquidityCache.empty;
  const empty = new Set<string>();
  await Promise.all(registry.pools().map(async (p) => {
    try {
      const [r0, r1] = (await publicClient().readContract({ address: p.address, abi: RESERVES_ABI, functionName: "getReserves" })) as [bigint, bigint, bigint];
      if (r0 === 0n || r1 === 0n) empty.add(p.address.toLowerCase());
    } catch { /* fail open */ }
  }));
  liquidityCache = { at: Date.now(), empty };
  return empty;
}

/** Route list marking empty pools, e.g. "BTC ⇄ MUSD · MUSD ⇄ mUSDT (no liquidity yet)". */
export async function routeListLive(): Promise<string> {
  const empty = await emptyPoolAddresses();
  return registry.pools()
    .map((p) => `${p.pair[0]} ⇄ ${p.pair[1]}${empty.has(p.address.toLowerCase()) ? " - ⚠️ no liquidity yet" : p.stable ? " (stable)" : ""}`)
    .join("\n• ");
}

/** Static route list (no RPC) for sync contexts like helpText. */
export function routeList(): string {
  return registry.pools().map((p) => `${p.pair[0]} ⇄ ${p.pair[1]}${p.stable ? " (stable)" : ""}`).join("\n• ");
}

/** Tokens with at least one FUNDED pool (i.e. actually swappable right now). */
async function swappableSymbols(): Promise<Set<string>> {
  const empty = await emptyPoolAddresses();
  const s = new Set<string>();
  for (const p of registry.pools()) {
    if (empty.has(p.address.toLowerCase())) continue;
    s.add(p.pair[0]); s.add(p.pair[1]);
  }
  return s;
}

/** A real, working swap example from the first live pool. */
export function swapExample(): string {
  const p = registry.pools()[0];
  if (!p) return "swap 100 MUSD to BTC";
  return `swap ${exAmt(p.pair[1]!)} ${p.pair[1]} to ${p.pair[0]}`;
}

// ── Swap picker flow: source token → destination → preset amount ─────────────
// Sniper-bot-style tap-to-swap. Amounts are % of the on-chain balance; the
// existing quote/confirm card takes over once an amount is chosen.

const NATIVE_GAS_BUFFER_WEI = 500_000_000_000_000n; // 0.0005 BTC kept for gas on Max

/** Step 1 — pick the token to sell (from non-zero, SWAPPABLE balances). */
async function swapFromCard(telegramId: number): Promise<Card> {
  const user = getUser(telegramId);
  if (!user) return noWalletCard();
  const [pooled, routes] = await Promise.all([swappableSymbols(), routeListLive()]);
  let holdings: Awaited<ReturnType<typeof getPortfolio>> = [];
  try { holdings = (await getPortfolio(user.address)).filter((h) => h.raw > 0n); } catch { /* empty */ }
  const sellable = holdings.filter((h) => pooled.has(h.token.symbol));
  const unpooled = holdings.filter((h) => !pooled.has(h.token.symbol));
  const kb = new InlineKeyboard();
  sellable.forEach((h, idx) => {
    kb.text(`${h.token.symbol} · ${prettyAmount(h.formatted)}`, `menu:swapfrom:${h.token.symbol}`);
    if (idx % 2 === 1) kb.row();
  });
  if (sellable.length % 2 === 1) kb.row();
  const header = `${b("💱 Swap")} - routes on ${netLabel}:\n• ${routes}\n\n`;
  const text = sellable.length
    ? header +
      `${b("Pick the token to sell:")}\n\n` +
      (unpooled.length ? i(`(${unpooled.map((h) => h.token.symbol).join(", ")} - no funded swap pool on this network yet.)`) + "\n" : "") +
      i(`Or just type it, e.g. "${swapExample()}".`)
    : header + i("No swappable balance yet - tap Deposit to fund your wallet, then come back.");
  return { text, keyboard: chrome(kb) };
}

/** Token symbols sharing a FUNDED pool with `from`. */
async function swapDestinations(from: string): Promise<string[]> {
  const empty = await emptyPoolAddresses();
  const dests = new Set<string>();
  for (const p of registry.pools()) {
    if (empty.has(p.address.toLowerCase())) continue;
    const [a, c] = p.pair;
    if (a === from) dests.add(c);
    else if (c === from) dests.add(a);
  }
  return [...dests];
}

/** Step 2 — pick what to buy (only tokens with a direct FUNDED pool). */
export async function swapToCard(from: string): Promise<Card> {
  const dests = await swapDestinations(from);
  const kb = new InlineKeyboard();
  dests.forEach((d, idx) => { kb.text(d, `menu:swapto:${from}:${d}`); if (idx % 2 === 1) kb.row(); });
  if (dests.length % 2 === 1) kb.row();
  const text = dests.length
    ? `${b(`💱 Swap ${from} → pick what to buy:`)}`
    : `${b(`💱 Swap ${from}`)}\n\n${i(`No funded pool from ${from} on this network yet. Try a different token.`)}`;
  return { text, keyboard: chrome(kb, "swap") };
}

/** Step 3 — pick a preset amount (% of balance) or type a custom one. */
export async function swapAmountCard(from: string, to: string, telegramId: number): Promise<Card> {
  const user = getUser(telegramId);
  let bal = "-";
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
    text: `${b("🏦 Borrow - MUSD against BTC")}\n\n` +
      `Deposit BTC as collateral and mint MUSD.\n` +
      i("Min debt 1,800 MUSD; keep your collateral ratio above 110% or risk liquidation. The live ratio is shown before you confirm."),
    keyboard: chrome(kb),
  };
}

async function earnCard(): Promise<Card> {
  const vaults = registry.vaults();
  const kb = new InlineKeyboard().text("⚡ Zap in", "menu:tip:earn_zap").text("🌊 Stake LP", "menu:tip:earn_stake").row();
  if (vaults.length) kb.text("🏛️ Vault", "menu:tip:earn_vault");
  kb.text("🌾 Claim", "menu:do:claim");
  const vaultLine = vaults.length
    ? `${b("Vaults:")}\n• ${vaults.map((v) => `${v.name} - deposit ${v.assetSymbol}`).join("\n• ")}`
    : i(`No vaults are published on ${netLabel} yet - LP staking and zaps are live.`);
  return {
    text: `${b("🌱 Earn - yield on your assets")}\n\n` +
      `${b("LP pools you can enter:")}\n• ${await routeListLive()}\n\n` +
      `${vaultLine}\n\n` +
      i("Zap turns ONE asset into a staked LP position in a single flow - the easiest way in."),
    keyboard: chrome(kb),
  };
}

function lockVoteCard(): Card {
  const kb = new InlineKeyboard()
    .text("🔒 Lock", "menu:tip:lock").text("⏫ Extend", "menu:tip:extendlock")
    .row()
    .text("🗳️ Vote", "menu:tip:vote").text("🌾 Claim", "menu:do:claim")
    .row()
    .text("🧰 veNFT tools", "menu:tip:venft_tools");
  return {
    text: `${b("🔒 Lock & Vote - veBTC / veMEZO")}\n\n` +
      `Lock BTC or MEZO for voting power, then direct emissions to pools.\n` +
      i("\"vote optimally\" runs the transparent water-filling allocator over live incentives."),
    keyboard: chrome(kb),
  };
}

function automateCard(): Card {
  const kb = new InlineKeyboard()
    .text("📋 My DCA", "menu:do:dcalist").text("➕ New DCA", "menu:tip:dca")
    .row()
    .text("♻️ Auto-compound ON", "menu:do:autocompound_on").text("⏹️ OFF", "menu:do:autocompound_off")
    .row()
    .text("🔔 Alerts", "menu:nav:alerts");
  return {
    text: `${b("⚡ Automate")}\n\n` +
      `• ${b("DCA")} - buy a fixed amount on a repeating schedule\n` +
      `• ${b("Auto-compound")} - claim & reinvest rewards each epoch\n` +
      `• ${b("Alerts")} - opt-in warnings: Trove health, unclaimed rewards, epoch votes\n\n` +
      i("Each automated run is scoped by your spending limits and can be paused any time (/pause)."),
    keyboard: chrome(kb),
  };
}

/** Opt-in proactive alerts. All OFF by default — the bot never messages first
 *  except for alert types the user explicitly enabled here. */
function alertsCard(telegramId: number): Card {
  if (!getUser(telegramId)) return noWalletCard();
  const p = store.alertPrefs(telegramId);
  const dot = (on: boolean) => (on ? "🟢" : "🔴");
  const kb = new InlineKeyboard()
    .text(`${dot(p.trove)} Trove health`, "menu:alert:trove")
    .row()
    .text(`${dot(p.rewards)} Unclaimed rewards`, "menu:alert:rewards")
    .row()
    .text(`${dot(p.epoch)} Epoch vote reminder`, "menu:alert:epoch");
  return {
    text: `${b("🔔 Alerts - the bot messages you first ONLY for these")}\n\n` +
      `${dot(p.trove)} ${b("Trove health")} - warns when your collateral ratio drops under 150%, with your live liquidation price.\n` +
      `${dot(p.rewards)} ${b("Unclaimed rewards")} - a nudge (max once a day) when you have rewards sitting unclaimed.\n` +
      `${dot(p.epoch)} ${b("Epoch vote reminder")} - in the final 24h of each weekly epoch, if you hold veNFTs.\n\n` +
      i("Tap to toggle. Checks run every ~30 minutes. Outside these, the bot never initiates a message - treat any unsolicited DM claiming to be us as a scam."),
    keyboard: chrome(kb, "automate"),
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
    case "alerts": return alertsCard(telegramId);
    case "accounts": return accountsCard(telegramId);
    case "settings": return settingsCard();
    case "help": return { text: helpText(), keyboard: chrome(new InlineKeyboard().text("📚 Learn the basics", "menu:nav:learn")) };
    case "learn": return learnCard();
    default: return undefined;
  }
}

// ── Tip (guidance) sub-cards for parameterized actions ───────────────────────

function poolNames(): string[] {
  return registry.pools().map((p) => p.pair.join("/"));
}

/**
 * Tip cards, built LAZILY so every example reflects the live registry (pools,
 * vaults) for the active network instead of a hardcoded pair that may not exist.
 */
function tipContent(key: string): { parent: string; text: string } | undefined {
  const pools = poolNames();
  const pool0 = pools[0] ?? "BTC/MUSD";
  const stable = registry.knownTokenSymbols().find((x) => x.toUpperCase() === "MUSD") ?? "MUSD";
  switch (key) {
    // There was no "swap" guidance at all, so every Swap guide button fell
    // through to the token picker — the one thing a user who tapped "how do I
    // phrase this?" did not want.
    case "swap": return { parent: "swap", text: `${b("💱 Swap")}\nType, e.g.:\n${code(`swap 100 ${stable} to BTC`)}\n${code("swap 0.01 BTC to " + stable)}\n\n${i("You'll see a live quote, the minimum you'd receive, and a confirm button before anything is signed.")}` };
    case "borrow_open": return { parent: "borrow", text: `${b("➕ Open Trove")}\nType, e.g.:\n${code("borrow 2000 MUSD against 0.1 BTC")}\n\n${i("Minimum debt 1,800 MUSD. You'll see the live collateral ratio and confirm before signing.")}` };
    case "borrow_repay": return { parent: "borrow", text: `${b("💵 Repay")}\nType:\n${code("repay 500 MUSD")}\n\n${i("Mezo enforces a minimum debt, so a partial repayment can't take you below it - I'll tell you the live figure if you get close. Use \"close trove\" to repay everything.")}` };
    case "borrow_adjust": return { parent: "borrow", text: `${b("🔧 Adjust Trove")}\nType any of:\n${code("add 0.05 BTC collateral")}\n${code("withdraw 0.02 BTC")}\n${code("mint 500 MUSD")}` };
    case "earn_stake": return { parent: "earn", text: `${b("🌊 Stake LP")}\nPools: ${pools.join(", ")}\n\nType:\n${code(`stake LP ${pool0}`)}\n\n${i("You need LP tokens first - get them with a zap or by adding liquidity.")}` };
    case "earn_vault": {
      const vaults = registry.vaults();
      if (!vaults.length) return { parent: "earn", text: `${b("🏛️ Vaults")}\n\n${i(`No vaults are published on ${netLabel} yet. LP staking and zaps are live - try those instead.`)}` };
      return { parent: "earn", text: `${b("🏛️ Vault deposit")}\n${vaults.map((v) => `• ${v.name} - deposit ${v.assetSymbol}`).join("\n")}\n\nType:\n${code(`deposit ${exAmt(vaults[0]!.assetSymbol)} ${vaults[0]!.assetSymbol} into vault`)}` };
    }
    case "earn_zap": return { parent: "earn", text: `${b("⚡ Zap into a pool")}\nPools: ${pools.join(", ")}\n\nType:\n${code(`zap 0.01 BTC into ${pool0}`)}\n\n${i("Splits one asset into a staked LP position in a single flow.")}` };
    case "lock": return { parent: "lockvote", text: `${b("🔒 Lock")}\nType:\n${code("lock 0.2 BTC for 28 days")}\n${code("lock 1000 MEZO for 2 years")}\n\n${i("veBTC locks run up to 28 days; veMEZO up to 4 years. Longer lock = more voting power.")}` };
    case "venft_tools": return { parent: "lockvote", text: `${b("🧰 veNFT tools")}\nManage the lock NFTs you already own:\n\n` +
      `${code("merge veNFT 1 into veNFT 2")}\n${i("combine two locks into one position")}\n\n` +
      `${code("transfer veNFT 1 to 0x…")}\n${i("send a lock to another address")}\n\n` +
      `${code("pair veNFT 1 with veMEZO 2: 100% " + (registry.pools()[0]?.pair.join("/") ?? "BTC/MUSD"))}\n${i("Matchbox boost - point veMEZO power at a pool")}` };
    case "extendlock": return { parent: "lockvote", text: `${b("⏫ Extend a lock")}\nType:\n${code("extend lock 3 by 30 days")}` };
    case "vote": return { parent: "lockvote", text: `${b("🗳️ Vote")}\nType:\n${code("vote optimally with veNFT 3")}\n${code(`vote with veNFT 3: 60% ${pool0}${pools[1] ? `, 40% ${pools[1]}` : ""}`)}\n\n${i("\"optimally\" splits your votes across gauges to maximize expected rewards, using live incentive data.")}` };
    case "dca": return { parent: "automate", text: `${b("➕ New DCA schedule")}\nType:\n${code("dca 50 MUSD to BTC every 24h")}\n${code("dca 100 MUSD to mUSDC every 7 days for 4 times")}` };
    case "switch": return { parent: "accounts", text: `${b("🔀 Switch account")}\nType:\n${code("switch to account 2")}\n\n${i("Indices are shown in the account list.")}` };
    case "export": return { parent: "accounts", text: `${b("🔑 Export private key")}\n${i("This reveals your key - anyone who sees it controls your funds. Only in a private chat.")}\n\nSend ${code("/export")} to start the guarded reveal.` };
    case "upgrade": return { parent: "settings", text: `${b("🔐 Smart-account upgrade (EIP-7702)")}\n${i("A scoped, revocable session key signs routine ops within on-chain caps, so your root key stays cold.")}\n\nSend ${code("/upgrade")} to enable it.` };
    default: return undefined;
  }
}

/**
 * Build a tip/guidance sub-card by key. Async because the borrow tip sizes its
 * example from the LIVE BTC price and the user's real balance — a hardcoded
 * "borrow 2000 MUSD against 0.1 BTC" goes stale the moment BTC moves, and can
 * suggest more collateral than the user owns.
 */
export async function tipCard(key: string, telegramId?: number): Promise<Card | undefined> {
  if (key === "borrow_open") return borrowOpenTip(telegramId);
  const t = tipContent(key);
  if (!t) return undefined;
  return { text: t.text, keyboard: chrome(new InlineKeyboard(), t.parent) };
}

/**
 * Live-sized "Open Trove" tip: real price, real balance, tappable command.
 *
 * The suggestion this card renders is TAPPABLE, so its arithmetic has to be the
 * same arithmetic the builder uses. It used to carry its own copy of the wrong
 * model — minimum debt 1,800 hardcoded, a 1% fee, and no gas compensation — so
 * once the builder was corrected this button would have offered a plan the
 * builder then refused. Now both size the loan through musdParams, and the
 * suggestion is derived from `maxNetMint` rather than re-derived by hand.
 */
async function borrowOpenTip(telegramId?: number): Promise<Card> {
  const { btcPriceWad } = await import("../core/prices.js");
  const { musdParams, compositeDebt, maxNetMint } = await import("../core/musdParams.js");
  const [priceWad, p] = await Promise.all([btcPriceWad().catch(() => undefined), musdParams()]);
  let btcHeld = 0;
  const user = telegramId ? getUser(telegramId) : undefined;
  if (user) {
    try {
      const h = (await getPortfolio(user.address)).find((x) => x.token.symbol === "BTC");
      if (h) btcHeld = Number(h.formatted);
    } catch { /* ignore */ }
  }

  const lines = [b("➕ Open Trove"), ""];
  const kb = new InlineKeyboard();
  if (priceWad !== undefined && p) {
    const price = Number(priceWad) / 1e18;
    const minNet = Number(p.minNetDebt) / 1e18;
    const gasComp = Number(p.gasCompensation) / 1e18;
    // Collateral for the SMALLEST loan at a comfortable 150% ratio, priced off
    // the debt the protocol actually records (mint + fee + gas compensation).
    const minDebtRecorded = Number(compositeDebt(p.minNetDebt, p, false)) / 1e18;
    const safeBtc = Number(((1.5 * minDebtRecorded) / price).toFixed(4));
    const affordable = btcHeld > 0 && btcHeld >= safeBtc;
    // If they hold more than the minimum needs, size the example to THEIR stack
    // (60% of it, keeping a buffer) instead of a fixed number.
    const useBtc = affordable ? Number(Math.max(safeBtc, btcHeld * 0.6).toFixed(4)) : safeBtc;
    // Headroom at 150%, not at MCR, so the suggestion is comfortable rather than
    // borderline. maxNetMint already nets out the fee and the gas compensation.
    const headroomAt150 = Number(maxNetMint(parseEther(String(useBtc)), priceWad, p, false)) / 1e18 * (Number(p.mcr) / 1e18) / 1.5;
    const debt = affordable
      ? Math.max(minNet, Math.floor(headroomAt150 / 100) * 100)
      : minNet;
    const cmd = `borrow ${debt} MUSD against ${useBtc} BTC`;
    lines.push(
      `BTC is ${b(`$${Math.round(price).toLocaleString()}`)} right now, so the smallest loan (${b(`${minNet.toLocaleString()} MUSD`)}) needs about ${b(`${safeBtc} BTC`)} at a safe 150% ratio.`,
      i(`Every Trove also carries ${gasComp} MUSD of gas compensation on top of what you mint, and that counts toward the ratio.`),
      "",
    );
    if (user && btcHeld > 0) {
      lines.push(
        affordable
          ? `You hold ${b(`${btcHeld} BTC`)} - enough. Suggested:`
          : `You hold ${b(`${btcHeld} BTC`)}, which is below that. Add more via Deposit, or borrow once funded:`,
        code(cmd),
        "",
      );
    } else {
      lines.push("Type, e.g.:", code(cmd), "");
    }
    if (affordable) kb.text(`▶ ${cmd}`, `menu:runborrow:${debt}:${useBtc}`).row();
    lines.push(i(`Minimum debt ${minNet.toLocaleString()} MUSD; keep the ratio above ${(Number(p.mcr) / 1e16).toFixed(0)}% or risk liquidation. You'll see the live ratio and confirm before signing.`));
  } else {
    // No live parameters means no honest example. Say so rather than printing a
    // number that might not be the protocol's.
    lines.push(
      "I can't read Mezo's live borrowing parameters right now, so I won't suggest a size - the numbers would be guesses.",
      "",
      i("Try again in a moment, or type a borrow and I'll check it against the live ratio before you confirm."),
    );
  }
  return { text: lines.join("\n"), keyboard: chrome(kb, "borrow") };
}

/**
 * Fee disclosure text — shared by /fees and the Settings → Fees card. Every
 * number is computed from the LIVE env config so this can never drift from
 * what is actually charged, and a worked example makes the rates concrete.
 */
export function feesText(): string {
  const lines = [b("💸 Fees - complete breakdown"), ""];
  if (feesEnabled) {
    const swapPct = env.fees.swapBps / 100;
    const refPct = env.fees.referredBps / 100;
    const hasDiscount = env.fees.referredBps < env.fees.swapBps;
    lines.push(
      b("What you pay:"),
      `• Swaps & zaps: ${b(`${swapPct}%`)} of the amount you put in, taken in that same token.`,
      ...(hasDiscount
        ? [`• …but if you joined via a referral link: ${b(`${refPct}%`)} on swaps & zaps - ${b("for life")}.`]
        : []),
      ...(env.fees.txnBps > 0
        ? [`• Borrow / vault deposit / lock: ${b(`${env.fees.txnBps / 100}%`)} of the amount, in that token.`]
        : []),
      `• Claiming rewards, voting, deposits, portfolio, DCA setup: ${b("free")} - no agent fee, ever.`,
      "",
      b("How it's collected:"),
      ...(registry.hasContract("FeeRouter")
        ? [`• Swap/zap fees are collected ${b("inside the same transaction")} as your trade (on-chain FeeRouter): a failed trade charges you nothing.`]
        : [`• Swap/zap fees are charged as a follow-up transfer after your trade confirms.`]),
      `• Borrow/lock fees are charged only ${b("after")} your action confirms on-chain.`,
      `• The exact fee amount is shown on ${b("every confirmation card")} before you approve.`,
      "",
      b("Referral split (swaps & zaps; from the fee, not from you):"),
      `• ${b(`${env.fees.referralSharePct}%`)} of your swap/zap fee goes to whoever referred you - paid instantly, on-chain, in the same transaction. It costs you nothing extra.`,
      `• The remaining ${100 - env.fees.referralSharePct}% goes to the operator: ${code(env.fees.recipient)}`,
      ...(env.fees.txnBps > 0 ? [`• Borrow/vault/lock fees carry no referral split.`] : []),
      "",
      b("Worked example - swap 1,000 MUSD:"),
      `• Fee: ${b(`${((1000 * env.fees.swapBps) / 10_000).toFixed(2)} MUSD`)} (${swapPct}%)` +
        (hasDiscount ? ` - or ${b(`${((1000 * env.fees.referredBps) / 10_000).toFixed(2)} MUSD`)} (${refPct}%) if you were referred` : ""),
      `• Of that fee, your referrer would receive ${((1000 * env.fees.referredBps * env.fees.referralSharePct) / 1_000_000).toFixed(3)} MUSD instantly.`,
      `• The other ${(1000 - (1000 * env.fees.swapBps) / 10_000).toFixed(2)} MUSD is swapped for you in full.`,
    );
  } else {
    lines.push("• No agent fee is currently charged on this deployment. Trades, borrows, and locks are free of agent fees.");
  }
  if (env.fees.automationNote) lines.push("", `• Automation (DCA / auto-compound): ${env.fees.automationNote}`);
  lines.push("", i("Network gas (BTC) is separate - it's paid to the chain, not the agent, on every transaction."));
  return lines.join("\n");
}

/** How-to / help card body — examples built from the live registry. */
export function helpText(): string {
  const pools = poolNames();
  const pool0 = pools[0] ?? "BTC/MUSD";
  const vaults = registry.vaults();
  return (
    `${b("❓ How to use Mezo Agent")}\n\n` +
    `${b("On this network")} (${netLabel}): ${registry.knownTokenSymbols().length} tokens ` +
    `(${registry.knownTokenSymbols().join(", ")}), ${pools.length} swap route${pools.length === 1 ? "" : "s"} ` +
    `(${pools.join(", ")})${vaults.length ? `, ${vaults.length} vault${vaults.length === 1 ? "" : "s"}` : ""}.\n\n` +
    `Tap a menu button, or just type what you want - I turn it into a simulated, confirmable transaction:\n` +
    `• ${swapExample()}\n• borrow 2000 MUSD against 0.1 BTC\n` +
    `• zap 0.01 BTC into ${pool0} · stake LP ${pool0}\n` +
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
    { command: "start", description: "🏠 Home - wallet, balances, menu" },
    { command: "portfolio", description: "💼 Balances & positions" },
    { command: "swap", description: "💱 Swap tokens" },
    { command: "borrow", description: "🏦 Borrow MUSD against BTC" },
    { command: "earn", description: "🌱 LP, vaults, zap, claim" },
    { command: "vote", description: "🔒 Lock & vote (veBTC)" },
    { command: "automate", description: "⚡ DCA & auto-compound" },
    { command: "alerts", description: "🔔 Opt-in warnings & reminders" },
    { command: "learn", description: "📚 DeFi basics, explained simply" },
    { command: "deposit", description: "📥 Deposit address + QR" },
    { command: "accounts", description: "👥 Manage wallets" },
    { command: "settings", description: "⚙️ Limits, fees, referral, upgrade" },
    { command: "fees", description: "💸 Fee disclosure" },
    { command: "help", description: "❓ How to use the bot" },
    { command: "pause", description: "🛑 Emergency stop automation" },
    { command: "diag", description: "🩺 Health self-test" },
  ]).catch(() => {});

  await bot.api.setMyShortDescription(
    "Operate the full Mezo Bitcoin-DeFi stack in plain language - borrow, swap, earn, lock & vote. Non-custodial, every action confirmed.",
  ).catch(() => {});

  await bot.api.setMyDescription(
    "Mezo Agent turns plain-English messages into safe, simulated Mezo transactions.\n\n" +
      "• Borrow MUSD against BTC, swap, zap into pools, stake LP, lock veBTC & vote\n" +
      "• Every fund-moving action is simulated and shown for confirmation before signing\n" +
      "• Spending limits, watch-only mode, and an emergency pause built in\n\n" +
      "Tap Start to create or import a wallet.",
  ).catch(() => {});
}
