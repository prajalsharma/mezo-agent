import { InlineKeyboard, type Bot } from "grammy";
import { env } from "../config/env.js";
import { getUser } from "../wallet/walletService.js";
import { getPortfolio, prettyAmount } from "../portfolio/portfolioService.js";
import { b, i, code } from "./format.js";

/**
 * Shared navigation surface. The leading Telegram trading bots (Trojan, Maestro,
 * BONKbot) all open on a wallet+balance "home" screen with a persistent button
 * grid and a Refresh action, and expose a slash-command menu + a profile
 * description. We mirror that pattern, adapted to a DeFi agent: buttons cover the
 * tap-friendly surfaces (portfolio, deposit, limits, referral, help) and a
 * "How to trade" guide bridges to the natural-language actions.
 */

const netLabel = env.network === "mainnet" ? "🟢 Mainnet" : "🧪 Testnet";

/** The persistent home-screen button grid. */
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Portfolio", "menu:portfolio").text("📥 Deposit", "menu:deposit")
    .row()
    .text("🔄 Swap", "menu:guide:swap").text("🏦 Borrow", "menu:guide:borrow")
    .row()
    .text("🌱 Earn", "menu:guide:earn").text("🗳️ Vote", "menu:guide:vote")
    .row()
    .text("⚙️ Limits", "menu:limits").text("🎁 Referral", "menu:referral")
    .row()
    .text("🔁 Refresh", "menu:refresh").text("❓ Help", "menu:help");
}

/** The wallet+balance "home" card shown on /start (returning user) and Refresh. */
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

/** Guidance shown when a natural-language surface button is tapped. */
export const GUIDES: Record<string, string> = {
  swap:
    `${b("🔄 Swap")}\nJust type it, e.g.\n` +
    `• swap 100 MUSD to mUSDC\n• swap 0.01 BTC to MUSD\n\n` +
    i("You'll get a live quote + slippage, then confirm before it signs."),
  borrow:
    `${b("🏦 Borrow (MUSD against BTC)")}\n` +
    `• borrow 2000 MUSD against 0.1 BTC\n• repay 500 MUSD\n• close trove\n\n` +
    i("Min debt 1,800 MUSD; keep your ratio above 110% or risk liquidation."),
  earn:
    `${b("🌱 Earn")}\n` +
    `• zap 0.01 BTC into BTC/MUSD\n• stake LP BTC/MUSD\n• deposit 100 MUSD into vault\n• claim all\n\n` +
    i("Zap splits one asset into an LP position in one flow."),
  vote:
    `${b("🗳️ Lock & Vote (veBTC)")}\n` +
    `• lock 0.2 BTC for 28 days\n• vote optimally with veNFT 3\n• claim all\n\n` +
    i("\"vote optimally\" runs the transparent water-filling allocator over live incentives."),
};

/**
 * Register the slash-command menu + profile description/bio at startup, so the
 * bot presents a polished first impression before the user even sends /start.
 * (setMyCommands/Description/ShortDescription — the Telegram UX primitives.)
 */
export async function installBotProfile(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Home — wallet, balances, menu" },
    { command: "portfolio", description: "Your balances & positions" },
    { command: "deposit", description: "Deposit address + QR to fund" },
    { command: "limits", description: "Spending caps & watch-only" },
    { command: "referral", description: "Your referral link & rewards" },
    { command: "export", description: "Reveal your private key (warned)" },
    { command: "upgrade", description: "EIP-7702 scoped smart account" },
    { command: "accounts", description: "Multiple accounts" },
    { command: "dca", description: "Dollar-cost-average schedules" },
    { command: "fees", description: "Fee disclosure" },
    { command: "pause", description: "Emergency stop automation" },
    { command: "resume", description: "Resume automation" },
    { command: "diag", description: "Health self-test" },
    { command: "help", description: "How to use the bot" },
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
