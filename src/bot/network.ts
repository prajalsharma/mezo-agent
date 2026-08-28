import { env } from "../config/env.js";
import { b, i } from "./format.js";

/**
 * The ONE place that decides how the current network is described to a user.
 *
 * Two problems with how this was done before:
 *
 *   1. The badge was redefined independently in five files (menu, onboarding,
 *      portfolio, swap, actions). Five copies of a safety-critical label is five
 *      chances for them to drift apart, and no single place to strengthen.
 *
 *   2. It was SYMMETRIC: "🧪 Testnet" against "🟢 Mainnet". A green circle reads
 *      as *reassuring* — the universal "all good" — when mainnet is precisely
 *      the mode where a mistake costs real bitcoin. The two modes are not
 *      equally consequential and should not look equally calm. Exactly one env
 *      var separates them, so the label carries real weight.
 *
 * Testnet copy therefore says the funds are not real; mainnet copy says they
 * are, in those words, because "Mainnet" alone means nothing to someone who has
 * never lost money to a chain they misread.
 */

export const isMainnet = env.network === "mainnet";

/** Short badge for card headers. Names the stake, not just the chain. */
export function networkBadge(): string {
  return isMainnet ? "🔴 MAINNET · real BTC" : "🧪 Testnet · test funds";
}

/** Compact badge where a header is already long (inline, mid-sentence). */
export function networkTag(): string {
  return isMainnet ? "🔴 MAINNET" : "🧪 Testnet";
}

/**
 * A line for anything that MOVES FUNDS, shown only on mainnet.
 *
 * Returns undefined on testnet so callers render nothing rather than reassuring
 * noise — a warning that appears on every screen everywhere stops being read.
 */
export function realFundsNotice(): string | undefined {
  if (!isMainnet) return undefined;
  return `🔴 ${b("This moves REAL funds on Mezo mainnet.")} Losses are permanent and nobody can reverse them.`;
}

/** The stake, in one plain sentence. For onboarding and deposits. */
export function stakeSentence(): string {
  return isMainnet
    ? `${b("This wallet holds REAL bitcoin.")} Anything you send here is real money, and this bot signs on your behalf within the limits you set.`
    : i("This is a TEST network. The BTC here has no value, so it is the right place to try things before real funds are involved.");
}

/**
 * Deposit-specific. Sending funds to an address on the wrong chain is one of the
 * few mistakes in this product that no amount of confirmation can undo, so the
 * deposit card names the chain explicitly rather than relying on the badge.
 */
export function depositChainWarning(): string {
  return isMainnet
    ? `⚠️ Send only ${b("Mezo mainnet")} assets to this address. Funds sent from another chain are lost.`
    : `⚠️ This is a ${b("test-network")} address. Do not send real BTC here - it would be lost, and the BTC you receive here is not real.`;
}

/**
 * `/network` — which chain am I on, and how do I reach my funds on the other one?
 *
 * This exists because the honest answer is not obvious and the failure is
 * expensive. The bot is ONE network per deployment (`MEZO_NETWORK`), so a user
 * cannot switch; only the operator can. Worse, the datastore is per-network
 * (`mezo-agent.<network>.json`), so flipping that variable brings the bot up
 * with an EMPTY account set and it will happily mint a brand-new wallet — while
 * the user's funds sit at their old address, untouched and unreachable.
 *
 * The thing that makes this recoverable is that an EVM address is derived from
 * the key, not the chain: the same private key is the same address on Mezo
 * testnet and Mezo mainnet. So the route to funds on the other network is
 * always "export the key, import it there" — never "hope the balance appears".
 */
export function networkCard(address?: string): string {
  const other = isMainnet ? "testnet" : "mainnet";
  const lines = [
    `${b("🌐 Network")}`,
    "",
    `You are on ${b(networkBadge())}.`,
    stakeSentence(),
  ];
  if (address) {
    lines.push("", `Your address on this network:`, `<code>${address}</code>`);
  }
  lines.push(
    "",
    b(`Where are my ${other} funds?`),
    `Still yours, at the ${b("same address")} - an address comes from your key, not from the chain, ` +
      `so you hold the identical address on both networks. This bot just isn't pointed at ${other} ` +
      `right now, so it cannot see or move them.`,
    "",
    `To reach them, either:`,
    `• ${b("Export and import")} - run /export here, then import that key into a wallet ` +
      `(MetaMask, Rabby) set to Mezo ${other}. Fastest, and works immediately.`,
    `• ${b("Ask the operator")} to run an instance on ${other}. Note that each instance needs its ` +
      `own Telegram bot, because one token can only drive one bot.`,
    "",
    i(
      `Heads up for whoever runs this: accounts are stored per network, so switching MEZO_NETWORK ` +
        `starts from an empty account list on the other chain. That is not data loss - the old file ` +
        `is untouched - but the bot will offer to create a NEW wallet, and funds live at the OLD one. ` +
        `Import the exported key instead of creating a new wallet.`,
    ),
  );
  return lines.join("\n");
}

/**
 * Operator-facing network line for the startup banner (server logs, not chat).
 *
 * It lives here rather than in bot.ts for the same reason everything else in
 * this file does — one place decides how a network is described — and because
 * scripts/productcopy.ts scans src/bot for copy that assumes testnet. A startup
 * log is not user-facing, but keeping the string here means the linter does not
 * need an exception carved for it, and the two descriptions cannot drift.
 */
export function startupNetworkLine(explicit: boolean): string {
  const what = isMainnet ? "🔴 MAINNET — REAL FUNDS" : "🧪 test network — no real funds";
  const source = explicit
    ? "(MEZO_NETWORK set explicitly)"
    : "(⚠️  MEZO_NETWORK is NOT SET — this is the DEFAULT. Set it if you meant mainnet.)";
  return `${what} ${source}`;
}
