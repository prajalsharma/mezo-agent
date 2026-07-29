import Anthropic from "@anthropic-ai/sdk";
import { env, llmEnabled } from "../config/env.js";
import { log, errMsg } from "../core/log.js";
import { Intent, INTENT_TOOL_SCHEMA, normalizeIntentFields, type Intent as IntentT } from "./intent.js";

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
  "Valid token symbols: {SYMBOLS}.",
  "Users often drop the Mezo 'm' prefix — map USDC->mUSDC, USDT->mUSDT, DAI->mDAI, cbBTC->mcbBTC, etc.",
  "Never invent tokens that cannot be resolved this way.",
  "For a SWAP use fields: action=swap, amount, fromToken, toToken.",
  "Do NOT use inputToken/inputAmount for a swap — those are ONLY for zap.",
  "If the amount, source, or destination is missing or ambiguous, return",
  "action=clarify with a precise question. Never guess amounts or tokens.",
].join(" ");

export async function parseIntent(
  message: string,
  knownSymbols: string[],
): Promise<IntentT> {
  // 1) DETERMINISTIC FIRST. The headline commands (swap/borrow/repay/lock/dca/
  //    zap/stake/…) are precise and structured, so the rule parser nails them
  //    instantly, for free, with zero dependence on any model. This is what makes
  //    "swap 0.0001 BTC to mUSDC" ALWAYS work — no LLM latency, no field-name
  //    risk, no rate limit. The LLM never even runs for a clear command.
  const rule = fallbackParse(message, knownSymbols);
  if (rule.action !== "clarify") return rule;

  // 2) LLM SECOND, only for what the rules couldn't parse — i.e. free-form,
  //    natural-language phrasing ("what can I do with my btc?", "put half my
  //    musd to work"). If the LLM is off or fails, we return the deterministic
  //    clarify (which already carries good, symbol-aware help text).
  if (!llmEnabled) return rule;

  const system = SYSTEM.replace("{SYMBOLS}", knownSymbols.join(", "));
  let raw: unknown;
  try {
    raw = env.llm.provider === "gemini"
      ? await callGemini(system, message)
      : await callAnthropic(system, message);
  } catch (err) {
    log.warn("llm.call-failed", { provider: env.llm.provider, error: errMsg(err) });
    return rule;
  }
  if (raw === undefined) return rule;

  // Deterministic validation — the model does not get the last word; the schema
  // does. normalizeIntentFields remaps loose cross-action aliases first, then we
  // canonicalize token symbols (USDC->mUSDC) so a valid intent isn't lost to a
  // prefix the user omitted.
  const parsed = Intent.safeParse(normalizeIntentFields(raw));
  if (!parsed.success) return rule;
  return canonicalizeIntentSymbols(parsed.data, knownSymbols);
}

/**
 * Resolve a user-typed token to a real registry symbol, tolerating the Mezo 'm'
 * prefix that users routinely omit: USDC->mUSDC, USDT->mUSDT, DAI->mDAI,
 * cbBTC->mcbBTC. Exact (case-insensitive) match wins; then try adding/removing a
 * leading 'm'. Returns undefined if nothing plausible matches.
 */
export function resolveSymbol(input: string, knownSymbols: string[]): string | undefined {
  const s = (input ?? "").trim().toLowerCase();
  if (!s) return undefined;
  let hit = knownSymbols.find((k) => k.toLowerCase() === s);
  if (hit) return hit;
  hit = knownSymbols.find((k) => k.toLowerCase() === "m" + s); // USDC -> mUSDC
  if (hit) return hit;
  if (s.startsWith("m")) {
    hit = knownSymbols.find((k) => k.toLowerCase() === s.slice(1)); // mBTC -> BTC
    if (hit) return hit;
  }
  return undefined;
}

/** Canonicalize the token-bearing fields of an LLM intent to real symbols. */
function canonicalizeIntentSymbols(intent: IntentT, knownSymbols: string[]): IntentT {
  const fix = (s: string) => resolveSymbol(s, knownSymbols) ?? s;
  switch (intent.action) {
    case "swap":
    case "dcaCreate":
      return { ...intent, fromToken: fix(intent.fromToken), toToken: fix(intent.toToken) };
    case "zap":
      return { ...intent, inputToken: fix(intent.inputToken) };
    case "vaultDeposit":
      return { ...intent, token: fix(intent.token) };
    case "autoCompound":
      return intent.intoToken ? { ...intent, intoToken: fix(intent.intoToken) } : intent;
    default:
      return intent;
  }
}

/**
 * Live LLM self-test for preflight / /diag. Sends one real request through the
 * active provider and confirms it returns a usable intent. This is what turns a
 * SILENT fallback ("why is it always using the parser?") into a visible ❌ with
 * the concrete provider error (bad key, wrong model name, rate limit, etc).
 * Returns a short human string on success; throws with the reason on failure.
 */
export async function llmSelfTest(knownSymbols: string[]): Promise<string> {
  if (!llmEnabled) throw new Error("no LLM key set — using deterministic parser");
  const system = SYSTEM.replace("{SYMBOLS}", knownSymbols.join(", "));
  const model = env.llm.provider === "gemini" ? env.llm.geminiModel : env.llm.anthropicModel;
  const raw =
    env.llm.provider === "gemini"
      ? await callGemini(system, "swap 1 MUSD to mUSDC")
      : await callAnthropic(system, "swap 1 MUSD to mUSDC");
  if (raw === undefined) throw new Error(`${env.llm.provider} returned no tool call`);
  // Any schema-valid intent proves the round-trip works; report the action so a
  // weak/over-cautious reply is visible. Only an OFF-schema reply is a failure,
  // and we surface the raw output so it can be diagnosed at a glance.
  const parsed = Intent.safeParse(normalizeIntentFields(raw));
  if (!parsed.success) {
    throw new Error(`replied off-schema: ${JSON.stringify(raw).slice(0, 140)}`);
  }
  return `${env.llm.provider} (${model}) responding — parsed action=${parsed.data.action}`;
}

/** Anthropic (Claude) backend. Returns the raw tool input, or undefined. */
async function callAnthropic(system: string, message: string): Promise<unknown> {
  const client = new Anthropic({ apiKey: env.llm.anthropicApiKey });
  const res = await client.messages.create({
    model: env.llm.anthropicModel,
    max_tokens: 512,
    system,
    tools: [INTENT_TOOL_SCHEMA as never],
    tool_choice: { type: "tool", name: INTENT_TOOL_SCHEMA.name },
    messages: [{ role: "user", content: message }],
  });
  const toolUse = res.content.find((c) => c.type === "tool_use");
  return toolUse && toolUse.type === "tool_use" ? toolUse.input : undefined;
}

/**
 * Google Gemini backend — via the OpenAI-compatible endpoint, so the SAME flat
 * function schema and forced tool_choice work unchanged and no extra SDK is
 * needed (native fetch). Gemini has a genuinely free tier (Google AI Studio key),
 * which makes it the zero-cost way to get real conversational parsing.
 */
async function callGemini(system: string, message: string): Promise<unknown> {
  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.llm.geminiApiKey}`,
      },
      body: JSON.stringify({
        model: env.llm.geminiModel,
        max_tokens: 512,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: INTENT_TOOL_SCHEMA.name,
              description: INTENT_TOOL_SCHEMA.description,
              parameters: INTENT_TOOL_SCHEMA.input_schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: INTENT_TOOL_SCHEMA.name } },
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const argsJson = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!argsJson) return undefined;
  try {
    return JSON.parse(argsJson);
  } catch {
    return undefined;
  }
}

/**
 * Deterministic fallback parser — covers the headline commands of every phase so
 * the bot is fully usable with no model vendor. The LLM path handles the long
 * tail; this never guesses tokens (it resolves against knownSymbols) or amounts.
 */
export function fallbackParse(message: string, knownSymbols: string[]): IntentT {
  const t = message.trim();
  const lower = t.toLowerCase();
  const resolve = (s: string) => resolveSymbol(s, knownSymbols);
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
