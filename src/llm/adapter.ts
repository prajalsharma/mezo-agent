import Anthropic from "@anthropic-ai/sdk";
import { env, llmEnabled } from "../config/env.js";
import { Intent, INTENT_TOOL_SCHEMA, type Intent as IntentT } from "./intent.js";

/**
 * Provider-agnostic reasoning adapter. Exposes ONE capability: turn a natural
 * language message into a validated Intent. It receives only non-sensitive
 * context (the message, and the list of known token symbols) — never keys,
 * balances tied to identity, or secrets.
 *
 * If no LLM is configured, `parseIntent` falls back to a deterministic regex
 * parser so the bot is fully usable without any model vendor.
 */

const SYSTEM = [
  "You are the intent parser for a Mezo DeFi Telegram agent.",
  "Output exactly one structured intent via the emit_intent tool.",
  "You never execute anything and never see private keys.",
  "Only these token symbols are valid — never invent others: {SYMBOLS}.",
  "If the amount, input token, or output token is missing or ambiguous, return",
  "action=clarify with a precise question. Never guess amounts or tokens.",
].join(" ");

export async function parseIntent(
  message: string,
  knownSymbols: string[],
): Promise<IntentT> {
  if (!llmEnabled) return fallbackParse(message, knownSymbols);

  const client = new Anthropic({ apiKey: env.llm.anthropicApiKey });
  const res = await client.messages.create({
    model: env.llm.anthropicModel,
    max_tokens: 512,
    system: SYSTEM.replace("{SYMBOLS}", knownSymbols.join(", ")),
    tools: [INTENT_TOOL_SCHEMA as never],
    tool_choice: { type: "tool", name: INTENT_TOOL_SCHEMA.name },
    messages: [{ role: "user", content: message }],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { action: "clarify", question: "Sorry, I couldn't understand that. Try: swap 100 MUSD to mUSDC" };
  }
  // Deterministic validation of the model's proposal — the model does not get
  // the last word; the schema does.
  const parsed = Intent.safeParse(toolUse.input);
  if (!parsed.success) {
    return { action: "clarify", question: "Could you rephrase? e.g. \"swap 100 MUSD to mUSDC\"" };
  }
  return parsed.data;
}

/**
 * Deterministic fallback parser — covers the headline commands of every phase so
 * the bot is fully usable with no model vendor. The LLM path handles the long
 * tail; this never guesses tokens (it resolves against knownSymbols) or amounts.
 */
export function fallbackParse(message: string, knownSymbols: string[]): IntentT {
  const t = message.trim();
  const lower = t.toLowerCase();
  const resolve = (s: string) => knownSymbols.find((k) => k.toLowerCase() === s.toLowerCase());
  const num = "(\\d+(?:\\.\\d+)?)";

  // Read-only / meta
  if (/\b(portfolio|balances?|holdings?|positions?)\b/.test(lower)) return { action: "portfolio" };
  if (/\bnew account\b|\bcreate account\b/.test(lower)) return { action: "account", op: "new" };
  if (/\blist accounts?\b|\bmy accounts?\b/.test(lower)) return { action: "account", op: "list" };
  { const m = lower.match(/switch.*account\s+(\d+)/); if (m) return { action: "account", op: "switch", index: Number(m[1]) }; }

  // Swap
  { const m = t.match(new RegExp(`(?:swap|trade|convert)\\s+${num}\\s+([a-z0-9]+)\\s+(?:to|for|into|->)\\s+([a-z0-9]+)`, "i"));
    if (m) { const f = resolve(m[2]!), to = resolve(m[3]!); if (f && to) return { action: "swap", amount: m[1]!, fromToken: f, toToken: to }; } }

  // DCA: "dca 50 MUSD to BTC every 24h [x5]"
  { const m = t.match(new RegExp(`dca\\s+${num}\\s+([a-z0-9]+)\\s+(?:to|into)\\s+([a-z0-9]+)\\s+every\\s+${num}\\s*(h|hour|hours|d|day|days)`, "i"));
    if (m) { const f = resolve(m[2]!), to = resolve(m[3]!); const unit = m[5]!.toLowerCase();
      const hours = unit.startsWith("d") ? Number(m[4]) * 24 : Number(m[4]);
      if (f && to) return { action: "dcaCreate", fromToken: f, toToken: to, amount: m[1]!, everyHours: hours }; } }
  if (/\bcancel dca\b|\bstop dca\b/.test(lower)) { const m = t.match(/dca\s+([0-9a-f]{4,})/i); return { action: "dcaCancel", ...(m ? { scheduleId: m[1] } : {}) }; }
  if (/\bauto.?compound\b/.test(lower)) return { action: "autoCompound", enabled: !/\boff|disable|stop\b/.test(lower) };

  // Borrow: "borrow 5000 MUSD against 0.1 BTC"
  { const m = t.match(new RegExp(`borrow\\s+${num}\\s+musd\\s+(?:against|with|using)\\s+${num}\\s+btc`, "i"));
    if (m) return { action: "borrow", mintMUSD: m[1]!, collateralBTC: m[2]! }; }
  { const m = t.match(new RegExp(`repay\\s+${num}\\s+musd`, "i")); if (m) return { action: "repay", repayMUSD: m[1]! }; }
  if (/\bclose\s+trove\b/.test(lower)) return { action: "closeTrove" };

  // Lock: "lock 0.2 BTC for 28 days" / "lock 1000 MEZO for 2 years"
  { const m = t.match(new RegExp(`lock\\s+${num}\\s+(btc|mezo)\\s+for\\s+${num}\\s*(day|days|week|weeks|year|years)`, "i"));
    if (m) { const unit = m[4]!.toLowerCase(); const n = Number(m[3]);
      const days = unit.startsWith("year") ? Math.round(n * 365) : unit.startsWith("week") ? n * 7 : n;
      return { action: "lock", asset: m[2]!.toUpperCase() as "BTC" | "MEZO", amount: m[1]!, lockDays: days }; } }

  // Vote / claim
  if (/\bvote\b/.test(lower)) return { action: "vote", mode: /\bmanual\b/.test(lower) ? "manual" : "optimal" };
  if (/\bclaim\b|\bharvest\b/.test(lower)) {
    const scope = /\brebase/.test(lower) ? "rebase" : /\bbribe/.test(lower) ? "bribe" : /\bgauge/.test(lower) ? "gauge" : "all";
    return { action: "claim", scope };
  }

  // Zap: "zap 0.01 BTC into MUSD/mUSDC"
  { const m = t.match(new RegExp(`zap\\s+${num}\\s+([a-z0-9]+)\\s+(?:into|to)\\s+([a-z0-9]+/[a-z0-9]+)`, "i"));
    if (m) { const f = resolve(m[2]!); if (f) return { action: "zap", inputToken: f, inputAmount: m[1]!, pool: m[3]!.toUpperCase(), stake: true }; } }

  // Stake / unstake LP: "stake LP MUSD/mUSDC"
  { const m = t.match(/(stake|unstake)\s+(?:lp\s+)?([a-z0-9]+\/[a-z0-9]+)/i);
    if (m) return m[1]!.toLowerCase() === "stake" ? { action: "stakeLp", pool: m[2]!.toUpperCase() } : { action: "unstakeLp", pool: m[2]!.toUpperCase() }; }

  // Market
  if (/\bbrowse market\b|\bmarket\b/.test(lower) && !/buy/.test(lower)) return { action: "marketBrowse" };
  { const m = t.match(/buy\s+(?:listing\s+)?([a-z0-9]+)/i); if (m) return { action: "marketBuy", listingId: m[1]! }; }

  return { action: "clarify", question: clarifyHelp(knownSymbols, t) };
}

/**
 * Build the "I didn't catch that" text from the symbols that actually exist on
 * the ACTIVE network.
 *
 * This used to hardcode `swap 100 MUSD to mUSDC`, which on testnet (where only
 * BTC and MUSD are registered) advertised a token the very same sentence then
 * omitted from "Known tokens" — so a user who copied the suggestion got the same
 * rejection back and reasonably concluded the amount was the problem. The
 * example must come from the same list the parser resolves against.
 */
function clarifyHelp(knownSymbols: string[], attempt: string): string {
  const quoted = new Set(knownSymbols.map((s) => s.toLowerCase()));
  // Name the specific unrecognised token when the message looked like a swap;
  // "mUSDC isn't available here" is far more actionable than a generic retry.
  const swapish = attempt.match(/(?:swap|trade|convert)\s+[\d.]+\s+([a-z0-9]+)\s+(?:to|for|into)\s+([a-z0-9]+)/i);
  const unknown = swapish
    ? [swapish[1]!, swapish[2]!].filter((s) => !quoted.has(s.toLowerCase()))
    : [];

  const pair =
    knownSymbols.length >= 2
      ? `swap 100 ${knownSymbols[1]} to ${knownSymbols[0]}`
      : `swap 100 ${knownSymbols[0] ?? "MUSD"} to BTC`;

  const lead = unknown.length
    ? `I don't know ${unknown.join(" or ")} on ${env.network}. Known tokens: ${knownSymbols.join(", ")}.`
    : `I didn't catch that. Known tokens: ${knownSymbols.join(", ")}.`;

  return (
    `${lead}\n\nTry: "${pair}", "borrow 5000 MUSD against 0.1 BTC", ` +
    `"lock 0.2 BTC for 28 days", "vote optimally", or /help.`
  );
}
