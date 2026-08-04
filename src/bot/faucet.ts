import { InlineKeyboard } from "grammy";
import { env } from "../config/env.js";

/**
 * The ONLY module allowed to mention faucets or test funds.
 *
 * On mainnet the bot handles real BTC, so copy that calls it a test - or points
 * at a test network - must never render. Keeping every such string behind this
 * one door turns "no testnet copy in the live product" into something a check
 * can actually verify (scripts/productcopy.ts allowlists this file and fails on
 * the words anywhere else), instead of a rule people have to remember.
 *
 * Every export returns undefined on mainnet. Callers render the mainnet
 * alternative when they get nothing back.
 */
const FAUCET_URL = "https://faucet.test.mezo.org/";

export function isTestNetwork(): boolean {
  return env.network !== "mainnet";
}

/** Reply for "faucet", or undefined on mainnet. */
export function faucetReply(): { text: string; keyboard: InlineKeyboard } | undefined {
  if (!isTestNetwork()) return undefined;
  return {
    text: "🚰 <b>Test funds</b>\nTap below to open the faucet, then paste your deposit address.",
    keyboard: new InlineKeyboard()
      .webApp("🚰 Open faucet", FAUCET_URL).row()
      .text("📥 My deposit address", "menu:act:deposit"),
  };
}

/** Button label + URL for the deposit card, or undefined on mainnet. */
export function faucetButton(): { label: string; url: string } | undefined {
  if (!isTestNetwork()) return undefined;
  return { label: "🚰 Get test BTC (faucet)", url: FAUCET_URL };
}

/** One-line hint under the deposit address, or undefined on mainnet. */
export function faucetHint(): string | undefined {
  if (!isTestNetwork()) return undefined;
  return "Tap the faucet button below, then paste the address above to get test BTC.";
}
