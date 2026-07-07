import { IntentSchema, type Intent } from "../intents/schema.js";
import { registry } from "./registry.js";

/**
 * Deterministic intent validator / disambiguation (README §5 step 2).
 *
 * Runs AFTER the reasoning layer. Re-validates the schema, resolves token
 * symbols against the registry, and applies domain rules that the model must
 * never be trusted to enforce (e.g. MUSD min net debt). Ambiguity => ask,
 * never guess.
 */

export type ValidationResult =
  | { ok: true; intent: Intent }
  | { ok: false; clarify: string };

// Mezo Borrow constants (README §2).
const MIN_NET_DEBT_MUSD = 1_800;

export function validateIntent(candidate: unknown): ValidationResult {
  const parsed = IntentSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, clarify: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const intent = parsed.data;

  switch (intent.action) {
    case "borrow": {
      if (intent.mintMUSD < MIN_NET_DEBT_MUSD) {
        return {
          ok: false,
          clarify: `Mezo requires a minimum net debt of ${MIN_NET_DEBT_MUSD} MUSD. Increase the amount to borrow.`,
        };
      }
      return { ok: true, intent };
    }
    case "swap": {
      if (intent.inputToken === intent.outputToken) {
        return { ok: false, clarify: "Input and output tokens are the same — nothing to swap." };
      }
      const unknown = [intent.inputToken, intent.outputToken].filter((t) => !registry.isKnownToken(t));
      if (unknown.length) {
        return { ok: false, clarify: `Unknown token(s): ${unknown.join(", ")}. Supported tokens come from the registry.` };
      }
      return { ok: true, intent };
    }
    case "zap": {
      if (!registry.isKnownToken(intent.inputToken)) {
        return { ok: false, clarify: `Unknown input token: ${intent.inputToken}.` };
      }
      if (!registry.listPools().includes(intent.targetPool.toUpperCase())) {
        return {
          ok: false,
          clarify: `Unknown pool "${intent.targetPool}". Available: ${registry.listPools().join(", ")}.`,
        };
      }
      return { ok: true, intent };
    }
    case "lock": {
      // veBTC = short locks (~1–30 days); veMEZO up to 4 years (README §2).
      const maxDays = intent.asset === "BTC" ? 30 : 4 * 365;
      if (intent.lockDays > maxDays) {
        return {
          ok: false,
          clarify: `${intent.asset} locks are capped at ${maxDays} days. Reduce the lock duration.`,
        };
      }
      return { ok: true, intent };
    }
    default:
      return { ok: true, intent };
  }
}
