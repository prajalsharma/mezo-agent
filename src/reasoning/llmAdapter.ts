import { config, type LlmProvider } from "../config.js";
import { IntentSchema, type Intent } from "../intents/schema.js";

/**
 * Provider-agnostic reasoning adapter (README §3, §11).
 *
 * Contract:
 *  - Input: only non-sensitive context (the user's message + optional balances).
 *  - Output: a typed `Intent`, validated against the Zod schema, OR a
 *    clarification request. NEVER calldata, NEVER an address, NEVER a secret.
 *
 * The default `fallback` provider is a deterministic rule-based parser so the
 * whole pipeline runs offline with no API key. Anthropic/OpenAI providers are
 * wired behind the same interface; they receive the schema as a tool definition.
 */

export type ParseResult =
  | { kind: "intent"; intent: Intent }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string };

export interface ReasoningAdapter {
  parseIntent(message: string, context?: NonSensitiveContext): Promise<ParseResult>;
}

/** Only balances/pools/prefs — never keys, seeds, or session secrets. */
export interface NonSensitiveContext {
  balances?: Record<string, number>;
  availablePools?: string[];
}

export function createReasoningAdapter(provider: LlmProvider = config.llm.provider): ReasoningAdapter {
  switch (provider) {
    case "anthropic":
    case "openai":
      // These providers would use function-calling with IntentSchema as the tool
      // definition. If the key is missing we degrade to the rule-based parser
      // rather than failing, so the demo path always works.
      if (provider === "anthropic" && !config.llm.anthropicKey) return new FallbackAdapter();
      if (provider === "openai" && !config.llm.openaiKey) return new FallbackAdapter();
      return new HostedAdapter(provider);
    case "fallback":
    default:
      return new FallbackAdapter();
  }
}

/**
 * Deterministic, no-network parser. It is intentionally conservative: if it
 * cannot fully resolve the required fields it returns a clarification instead
 * of guessing amounts or addresses (README §5 step 2).
 */
export class FallbackAdapter implements ReasoningAdapter {
  async parseIntent(message: string): Promise<ParseResult> {
    const text = message.trim().toLowerCase();

    if (/\b(portfolio|balance|positions?|holdings?)\b/.test(text)) {
      return ok({ action: "portfolio" });
    }

    if (/\bborrow\b|\bopen (a )?trove\b|\bmint musd\b/.test(text)) {
      const btc = firstAmountNear(text, ["btc"]);
      const musd = firstAmountNear(text, ["musd"]);
      if (btc === undefined || musd === undefined) {
        return clarify(
          "How much BTC collateral and how much MUSD do you want to mint? e.g. \"borrow with 0.1 BTC, mint 5000 MUSD\".",
        );
      }
      return ok({ action: "borrow", collateralBTC: btc, mintMUSD: musd });
    }

    if (/\brepay\b|\bpay (back|down)\b/.test(text)) {
      const musd = firstAmountNear(text, ["musd"]) ?? firstNumber(text);
      if (musd === undefined) return clarify("How much MUSD do you want to repay?");
      return ok({ action: "repay", repayMUSD: musd });
    }

    if (/\bswap\b|\btrade\b|\bexchange\b/.test(text)) {
      const pair = parseSwapPair(text);
      if (!pair) {
        return clarify('Which tokens and how much? e.g. "swap 0.05 BTC to MUSD".');
      }
      return ok({
        action: "swap",
        inputToken: pair.inputToken,
        outputToken: pair.outputToken,
        inputAmount: pair.inputAmount,
        slippageBps: 50,
      });
    }

    if (/\bzap\b|\bprovide liquidity\b|\benter (the )?pool\b|\bdeposit into\b/.test(text)) {
      const amount = firstNumber(text);
      const pool = parsePool(text);
      const token = detectToken(text) ?? "BTC";
      if (amount === undefined || !pool) {
        return clarify(
          'Which pool and how much of which token? e.g. "zap 800 BTC into MUSD/mUSDC".',
        );
      }
      return ok({ action: "zap", inputToken: token, inputAmount: amount, targetPool: pool, stake: true });
    }

    if (/\block\b/.test(text)) {
      const asset = /\bmezo\b/.test(text) ? "MEZO" : "BTC";
      const amount = firstNumber(text);
      const days = parseDays(text);
      if (amount === undefined || days === undefined) {
        return clarify(
          'How much and for how long? e.g. "lock 0.2 BTC for 28 days" or "lock 1000 MEZO for 2 years".',
        );
      }
      return ok({ action: "lock", asset, amount, lockDays: days });
    }

    if (/\bvote\b/.test(text)) {
      const optimal = /\boptimal|best|auto\b/.test(text);
      return ok({ action: "vote", mode: optimal ? "optimal" : "optimal" });
    }

    if (/\bclaim\b|\bharvest\b|\bcollect\b/.test(text)) {
      const scope = /\brebase\b/.test(text)
        ? "rebase"
        : /\bbribe\b/.test(text)
          ? "bribe"
          : /\bgauge\b/.test(text)
            ? "gauge"
            : "all";
      return ok({ action: "claim", scope });
    }

    return {
      kind: "unsupported",
      reason:
        "I couldn't map that to a supported action (borrow, repay, swap, zap, lock, vote, claim, portfolio). Try rephrasing.",
    };
  }
}

/**
 * Hosted LLM path. Uses function-calling with the Zod schema as the tool
 * definition. Kept thin on purpose (README §3): the model output is always
 * re-validated against IntentSchema by the deterministic core.
 */
export class HostedAdapter implements ReasoningAdapter {
  constructor(private readonly provider: "anthropic" | "openai") {}

  async parseIntent(message: string, context?: NonSensitiveContext): Promise<ParseResult> {
    // NOTE: real HTTP call omitted to keep the skeleton dependency-light and to
    // avoid shipping a half-wired provider. The integration point is explicit:
    // 1) send `message` + `context` (NEVER secrets) + IntentSchema as tool spec,
    // 2) receive a tool call, 3) re-validate here. Until wired, degrade safely.
    void context;
    void this.provider;
    return new FallbackAdapter().parseIntent(message);
  }
}

// -------------------- helpers (validated against the schema) --------------------

function ok(candidate: unknown): ParseResult {
  const parsed = IntentSchema.safeParse(candidate);
  if (!parsed.success) {
    return { kind: "unsupported", reason: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { kind: "intent", intent: parsed.data };
}

function clarify(question: string): ParseResult {
  return { kind: "clarify", question };
}

const TOKEN_WORDS = ["btc", "musd", "mezo", "musdc", "usdc", "usdt", "susd", "smusd"];

function detectToken(text: string): string | undefined {
  for (const t of TOKEN_WORDS) {
    if (new RegExp(`\\b${t}\\b`).test(text)) return t.toUpperCase();
  }
  return undefined;
}

function firstNumber(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

/** Find a number that appears adjacent to one of the given unit words. */
function firstAmountNear(text: string, units: string[]): number | undefined {
  for (const u of units) {
    const before = text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${u}\\b`));
    if (before) return Number(before[1]);
    const after = text.match(new RegExp(`${u}\\s*(?:of|:)?\\s*(\\d+(?:\\.\\d+)?)`));
    if (after) return Number(after[1]);
  }
  return undefined;
}

function parseSwapPair(
  text: string,
): { inputToken: string; outputToken: string; inputAmount: number } | undefined {
  // matches "swap 0.05 btc to musd" / "trade 100 musd for mezo"
  const m = text.match(
    /(\d+(?:\.\d+)?)\s*([a-z]{2,6})\s*(?:to|for|into|->)\s*([a-z]{2,6})/,
  );
  if (!m) return undefined;
  return { inputAmount: Number(m[1]), inputToken: m[2].toUpperCase(), outputToken: m[3].toUpperCase() };
}

function parsePool(text: string): string | undefined {
  const m = text.match(/([a-z0-9]{2,8}\/[a-z0-9]{2,8})/i);
  return m ? m[1].toUpperCase() : undefined;
}

function parseDays(text: string): number | undefined {
  const y = text.match(/(\d+(?:\.\d+)?)\s*year/);
  if (y) return Math.round(Number(y[1]) * 365);
  const w = text.match(/(\d+(?:\.\d+)?)\s*week/);
  if (w) return Math.round(Number(w[1]) * 7);
  const d = text.match(/(\d+)\s*day/);
  if (d) return Number(d[1]);
  return undefined;
}
