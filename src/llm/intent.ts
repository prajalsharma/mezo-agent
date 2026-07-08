import { z } from "zod";

/**
 * Typed intents. The LLM's ONLY output is one of these — never calldata, never
 * an address, never a final decision to move funds. The same Zod schema is the
 * LLM tool schema and the deterministic validator (one definition, two
 * enforcement points), so anything off-schema is rejected before it can act.
 */

export const SwapIntent = z.object({
  action: z.literal("swap"),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a plain number"),
  fromToken: z.string().min(1),
  toToken: z.string().min(1),
  slippagePct: z.number().min(0.01).max(50).optional(),
});
export type SwapIntent = z.infer<typeof SwapIntent>;

/** Used when the model cannot map the message to a supported, unambiguous action. */
export const ClarifyIntent = z.object({
  action: z.literal("clarify"),
  question: z.string().min(1),
});
export type ClarifyIntent = z.infer<typeof ClarifyIntent>;

export const Intent = z.discriminatedUnion("action", [SwapIntent, ClarifyIntent]);
export type Intent = z.infer<typeof Intent>;

/** JSON-schema-ish description handed to the LLM's tool/function-calling. */
export const INTENT_TOOL_SCHEMA = {
  name: "emit_intent",
  description:
    "Translate the user's message into a single structured Mezo intent. " +
    "Never invent token symbols or amounts. If the amount, input token, or output " +
    "token is missing or ambiguous, use action \"clarify\" with a specific question.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["swap", "clarify"] },
      amount: { type: "string", description: "plain number, no symbol, e.g. \"0.05\"" },
      fromToken: { type: "string", description: "token symbol being spent, e.g. MUSD" },
      toToken: { type: "string", description: "token symbol being received, e.g. mUSDC" },
      slippagePct: { type: "number", description: "optional, 0.01–50" },
      question: { type: "string", description: "for action=clarify only" },
    },
    required: ["action"],
  },
} as const;
