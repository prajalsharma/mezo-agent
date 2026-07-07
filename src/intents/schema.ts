import { z } from "zod";

/**
 * The Intent schema is the single source of truth (README §11): it is both the
 * LLM tool/function-calling schema AND the deterministic validator. The LLM may
 * only emit one of these shapes. Anything off-schema is rejected before any
 * transaction is built.
 *
 * Invariant (README §1): the model never emits addresses or raw calldata.
 * Tokens are referenced by SYMBOL and resolved against the registry later.
 */

const positive = z.number().positive();
const tokenSymbol = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9]+$/, "token symbols are alphanumeric, resolved via registry");

// ---- Borrow (MUSD / Troves) ----
export const BorrowIntent = z.object({
  action: z.literal("borrow"),
  collateralBTC: positive.describe("BTC deposited as collateral"),
  mintMUSD: positive.describe("MUSD to mint; min net debt 1800 enforced downstream"),
});

export const RepayIntent = z.object({
  action: z.literal("repay"),
  repayMUSD: positive,
});

// ---- Swap (DEX) ----
export const SwapIntent = z.object({
  action: z.literal("swap"),
  inputToken: tokenSymbol,
  outputToken: tokenSymbol,
  inputAmount: positive,
  slippageBps: z.number().int().min(1).max(5000).default(50),
});

// ---- Earn / zap ----
export const ZapIntent = z.object({
  action: z.literal("zap"),
  inputToken: tokenSymbol,
  inputAmount: positive,
  targetPool: z.string().min(1).describe("pool identifier, e.g. MUSD/mUSDC"),
  stake: z.boolean().default(true).describe("stake resulting LP into the gauge"),
});

// ---- Locking / veNFTs ----
export const LockIntent = z.object({
  action: z.literal("lock"),
  asset: z.enum(["BTC", "MEZO"]),
  amount: positive,
  lockDays: z.number().int().positive(),
});

// ---- Voting ----
export const VoteIntent = z.object({
  action: z.literal("vote"),
  // "optimal" defers allocation to the optimizer service (README §7).
  mode: z.enum(["manual", "optimal"]).default("optimal"),
  // manual mode: pool -> weight (bps). optimizer fills this in optimal mode.
  weights: z.record(z.string(), z.number().int().min(0).max(10_000)).optional(),
});

// ---- Claims ----
export const ClaimIntent = z.object({
  action: z.literal("claim"),
  scope: z.enum(["all", "rebase", "gauge", "bribe"]).default("all"),
});

// ---- Read-only portfolio ----
export const PortfolioIntent = z.object({
  action: z.literal("portfolio"),
});

export const IntentSchema = z.discriminatedUnion("action", [
  BorrowIntent,
  RepayIntent,
  SwapIntent,
  ZapIntent,
  LockIntent,
  VoteIntent,
  ClaimIntent,
  PortfolioIntent,
]);

export type Intent = z.infer<typeof IntentSchema>;
export type IntentAction = Intent["action"];

/** Actions that move funds and therefore require simulate + confirm + sign. */
export const FUND_MOVING_ACTIONS: readonly IntentAction[] = [
  "borrow",
  "repay",
  "swap",
  "zap",
  "lock",
  "vote",
  "claim",
];

export function isFundMoving(action: IntentAction): boolean {
  return FUND_MOVING_ACTIONS.includes(action);
}
