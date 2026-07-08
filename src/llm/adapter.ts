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

/** Deterministic fallback: "swap <amount> <TOKEN> to|for|-> <TOKEN>". */
export function fallbackParse(message: string, knownSymbols: string[]): IntentT {
  const m = message
    .trim()
    .match(/(?:swap|trade|convert)\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+(?:to|for|into|->)\s+([a-z0-9]+)/i);
  if (!m) {
    return {
      action: "clarify",
      question: `I understand swaps like: "swap 100 MUSD to mUSDC". Known tokens: ${knownSymbols.join(", ")}.`,
    };
  }
  const [, amount, from, to] = m;
  const resolve = (s: string) =>
    knownSymbols.find((k) => k.toLowerCase() === s!.toLowerCase());
  const fromToken = resolve(from!);
  const toToken = resolve(to!);
  if (!fromToken || !toToken) {
    return {
      action: "clarify",
      question: `I only know these tokens: ${knownSymbols.join(", ")}. Which did you mean?`,
    };
  }
  return { action: "swap", amount: amount!, fromToken, toToken };
}
