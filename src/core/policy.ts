import { config } from "../config.js";
import type { Intent } from "../intents/schema.js";

/**
 * App-level policy engine (defense-in-depth layer 1, README §1 rule 2 & §4).
 *
 * This is the FIRST of three gates. It enforces per-action caps, allowlists and
 * watch-only mode before anything is built or signed. The signer re-checks
 * policy independently (layer 2), and an on-chain module would enforce it again
 * (layer 3). A compromise of any single layer must not drain an account.
 */

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

// Naive in-memory daily accounting. Production uses the datastore keyed per user.
const dailyBtcSpent = new Map<string, { day: string; amount: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function checkPolicy(userId: string, intent: Intent): PolicyResult {
  if (config.policy.watchOnly) {
    return { allowed: false, reason: "Watch-only mode is enabled. No fund-moving actions are permitted." };
  }

  switch (intent.action) {
    case "borrow": {
      if (intent.collateralBTC > config.policy.maxBtcPerAction) {
        return capExceeded("BTC per action", intent.collateralBTC, config.policy.maxBtcPerAction, "BTC");
      }
      if (intent.mintMUSD > config.policy.maxMusdPerAction) {
        return capExceeded("MUSD per action", intent.mintMUSD, config.policy.maxMusdPerAction, "MUSD");
      }
      return chargeDailyBtc(userId, intent.collateralBTC);
    }
    case "repay": {
      if (intent.repayMUSD > config.policy.maxMusdPerAction) {
        return capExceeded("MUSD per action", intent.repayMUSD, config.policy.maxMusdPerAction, "MUSD");
      }
      return { allowed: true };
    }
    case "swap": {
      if (intent.inputToken === "BTC" && intent.inputAmount > config.policy.maxBtcPerAction) {
        return capExceeded("BTC per action", intent.inputAmount, config.policy.maxBtcPerAction, "BTC");
      }
      if (intent.inputToken === "BTC") return chargeDailyBtc(userId, intent.inputAmount);
      return { allowed: true };
    }
    case "zap": {
      if (intent.inputToken === "BTC") {
        if (intent.inputAmount > config.policy.maxBtcPerAction) {
          return capExceeded("BTC per action", intent.inputAmount, config.policy.maxBtcPerAction, "BTC");
        }
        return chargeDailyBtc(userId, intent.inputAmount);
      }
      return { allowed: true };
    }
    case "lock": {
      if (intent.asset === "BTC") {
        if (intent.amount > config.policy.maxBtcPerAction) {
          return capExceeded("BTC per action", intent.amount, config.policy.maxBtcPerAction, "BTC");
        }
        return chargeDailyBtc(userId, intent.amount);
      }
      return { allowed: true };
    }
    case "vote":
    case "claim":
    case "portfolio":
      // No direct value out; still passes through confirm + sign for vote/claim.
      return { allowed: true };
  }
}

function capExceeded(what: string, got: number, cap: number, unit: string): PolicyResult {
  return {
    allowed: false,
    reason: `Blocked by policy: ${what} cap is ${cap} ${unit}, requested ${got} ${unit}. Raise the cap or split the action.`,
  };
}

function chargeDailyBtc(userId: string, amount: number): PolicyResult {
  const key = userId;
  const entry = dailyBtcSpent.get(key);
  const day = today();
  const prior = entry && entry.day === day ? entry.amount : 0;
  if (prior + amount > config.policy.dailyBtcCap) {
    return {
      allowed: false,
      reason: `Blocked by policy: daily BTC cap is ${config.policy.dailyBtcCap} BTC (already used ${prior}, requested ${amount}).`,
    };
  }
  dailyBtcSpent.set(key, { day, amount: prior + amount });
  return { allowed: true };
}
