import { z } from "zod";

/**
 * Typed intents. The LLM's ONLY output is one of these — never calldata, never
 * an address, never a final decision to move funds. The same Zod schema is the
 * LLM tool schema and the deterministic validator (one definition, two
 * enforcement points), so anything off-schema is rejected before it can act.
 *
 * Amounts are strings (plain decimal numbers) so the model can't smuggle in
 * bigints/precision tricks; they are parsed with the token's decimals downstream.
 */

// z.coerce so a model that returns a JSON number (1) instead of a string ("1")
// — Gemini and others do this routinely — is accepted; the regex still enforces
// a plain decimal shape afterwards. Prevents a valid swap being rejected as
// off-schema just because of number-vs-string.
const amount = z.coerce.string().regex(/^\d+(\.\d+)?$/, "amount must be a plain number");
const symbol = z.string().min(1).max(12);
const slippage = z.number().min(0.01).max(50).optional();

// ── Swap (Phase 1) ───────────────────────────────────────────────────────────
export const SwapIntent = z.object({
  action: z.literal("swap"),
  amount,
  fromToken: symbol,
  toToken: symbol,
  slippagePct: slippage,
});

// ── Phase 2: Borrow / Earn ───────────────────────────────────────────────────
export const BorrowIntent = z.object({
  action: z.literal("borrow"),
  collateralBTC: amount,
  mintMUSD: amount,
});
export const RepayIntent = z.object({
  action: z.literal("repay"),
  repayMUSD: amount,
});
export const AdjustIntent = z.object({
  action: z.literal("adjust"),
  addCollateralBTC: amount.optional(),
  withdrawCollateralBTC: amount.optional(),
  mintMUSD: amount.optional(),
  repayMUSD: amount.optional(),
});
export const CloseTroveIntent = z.object({ action: z.literal("closeTrove") });
export const VaultDepositIntent = z.object({
  action: z.literal("vaultDeposit"),
  token: symbol,
  amount,
});
export const StakeLpIntent = z.object({
  action: z.literal("stakeLp"),
  pool: z.string().min(1),
  amount: amount.optional(), // omitted => stake full LP balance
});
export const UnstakeLpIntent = z.object({
  action: z.literal("unstakeLp"),
  pool: z.string().min(1),
  amount: amount.optional(),
});
export const ClaimIntent = z.object({
  action: z.literal("claim"),
  scope: z.enum(["all", "rebase", "gauge", "bribe"]).default("all"),
});

// ── Phase 3: Lock / Vote / Market ────────────────────────────────────────────
export const LockIntent = z.object({
  action: z.literal("lock"),
  asset: z.enum(["BTC", "MEZO"]),
  amount,
  lockDays: z.number().int().positive(),
});
export const ExtendLockIntent = z.object({
  action: z.literal("extendLock"),
  tokenId: z.number().int().nonnegative(),
  addDays: z.number().int().positive().optional(),
  addAmount: amount.optional(),
});
export const VoteIntent = z.object({
  action: z.literal("vote"),
  mode: z.enum(["manual", "optimal"]).default("optimal"),
  // manual mode: pool identifier -> weight in basis points.
  weights: z.record(z.string(), z.number().int().min(0).max(10_000)).optional(),
  // The veBTC NFT casting the vote ("vote with veNFT 3 ..."). Required for
  // on-chain submission; without it the bot asks instead of guessing.
  tokenId: z.string().regex(/^\d+$/).optional(),
});
export const MarketBrowseIntent = z.object({
  action: z.literal("marketBrowse"),
  query: z.string().optional(),
});
export const MarketBuyIntent = z.object({
  action: z.literal("marketBuy"),
  listingId: z.string().min(1),
});

// ── Phase 4: Zap / Matchbox / veNFT ──────────────────────────────────────────
export const ZapIntent = z.object({
  action: z.literal("zap"),
  inputToken: symbol,
  inputAmount: amount,
  pool: z.string().min(1),
  stake: z.boolean().default(true),
  slippagePct: slippage,
});
export const MatchboxIntent = z.object({
  action: z.literal("matchbox"),
  op: z.enum(["pair", "unpair"]).default("pair"),
  veBtcId: z.number().int().nonnegative().optional(),
  veMezoId: z.number().int().nonnegative().optional(),
  /** Pool → boost weight in basis points (pair mode; must sum to 10000). */
  weights: z.record(z.string(), z.number().int().min(0).max(10_000)).optional(),
});
export const VeTransferIntent = z.object({
  action: z.literal("veTransfer"),
  tokenId: z.number().int().nonnegative(),
  to: z.string().min(1),
});
export const VeMergeIntent = z.object({
  action: z.literal("veMerge"),
  fromTokenId: z.number().int().nonnegative(),
  toTokenId: z.number().int().nonnegative(),
});

// ── Phase 5: automation / accounts ───────────────────────────────────────────
export const DcaCreateIntent = z.object({
  action: z.literal("dcaCreate"),
  fromToken: symbol,
  toToken: symbol,
  amount, // per interval
  everyHours: z.number().int().positive(),
  occurrences: z.number().int().positive().optional(),
});
export const DcaCancelIntent = z.object({
  action: z.literal("dcaCancel"),
  scheduleId: z.string().optional(), // omitted => list
});
export const AutoCompoundIntent = z.object({
  action: z.literal("autoCompound"),
  enabled: z.boolean(),
  intoToken: symbol.optional(),
});
export const AccountIntent = z.object({
  action: z.literal("account"),
  op: z.enum(["new", "list", "switch"]),
  index: z.number().int().nonnegative().optional(),
});

// ── Read / meta ──────────────────────────────────────────────────────────────
export const PortfolioIntent = z.object({ action: z.literal("portfolio") });
export const ClarifyIntent = z.object({
  action: z.literal("clarify"),
  question: z.string().min(1),
});

export const Intent = z.discriminatedUnion("action", [
  SwapIntent,
  BorrowIntent,
  RepayIntent,
  AdjustIntent,
  CloseTroveIntent,
  VaultDepositIntent,
  StakeLpIntent,
  UnstakeLpIntent,
  ClaimIntent,
  LockIntent,
  ExtendLockIntent,
  VoteIntent,
  MarketBrowseIntent,
  MarketBuyIntent,
  ZapIntent,
  MatchboxIntent,
  VeTransferIntent,
  VeMergeIntent,
  DcaCreateIntent,
  DcaCancelIntent,
  AutoCompoundIntent,
  AccountIntent,
  PortfolioIntent,
  ClarifyIntent,
]);
export type Intent = z.infer<typeof Intent>;
export type IntentAction = Intent["action"];

// Convenience type aliases used across surfaces.
export type SwapIntent = z.infer<typeof SwapIntent>;
export type BorrowIntent = z.infer<typeof BorrowIntent>;
export type RepayIntent = z.infer<typeof RepayIntent>;
export type AdjustIntent = z.infer<typeof AdjustIntent>;
export type VaultDepositIntent = z.infer<typeof VaultDepositIntent>;
export type StakeLpIntent = z.infer<typeof StakeLpIntent>;
export type UnstakeLpIntent = z.infer<typeof UnstakeLpIntent>;
export type ClaimIntent = z.infer<typeof ClaimIntent>;
export type LockIntent = z.infer<typeof LockIntent>;
export type ExtendLockIntent = z.infer<typeof ExtendLockIntent>;
export type VoteIntent = z.infer<typeof VoteIntent>;
export type MarketBuyIntent = z.infer<typeof MarketBuyIntent>;
export type ZapIntent = z.infer<typeof ZapIntent>;
export type MatchboxIntent = z.infer<typeof MatchboxIntent>;
export type VeTransferIntent = z.infer<typeof VeTransferIntent>;
export type VeMergeIntent = z.infer<typeof VeMergeIntent>;
export type DcaCreateIntent = z.infer<typeof DcaCreateIntent>;
export type DcaCancelIntent = z.infer<typeof DcaCancelIntent>;
export type AutoCompoundIntent = z.infer<typeof AutoCompoundIntent>;
export type AccountIntent = z.infer<typeof AccountIntent>;

/** JSON-schema-ish description handed to the LLM's tool/function-calling. */
export const INTENT_TOOL_SCHEMA = {
  name: "emit_intent",
  description:
    "Translate the user's message into a single structured Mezo intent. Never invent token " +
    "symbols, amounts, addresses, or ids. If a required field is missing or ambiguous, use " +
    "action \"clarify\" with a specific question. Supported actions: swap, borrow, repay, adjust, " +
    "closeTrove, vaultDeposit, stakeLp, unstakeLp, claim, lock, extendLock, vote, marketBrowse, " +
    "marketBuy, zap, matchbox, veTransfer, veMerge, dcaCreate, dcaCancel, autoCompound, account, " +
    "portfolio, clarify.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string" },
      amount: { type: "string", description: "plain number, no symbol, e.g. \"0.05\"" },
      fromToken: { type: "string" },
      toToken: { type: "string" },
      slippagePct: { type: "number" },
      collateralBTC: { type: "string" },
      mintMUSD: { type: "string" },
      repayMUSD: { type: "string" },
      token: { type: "string" },
      pool: { type: "string" },
      scope: { type: "string", enum: ["all", "rebase", "gauge", "bribe"] },
      asset: { type: "string", enum: ["BTC", "MEZO"] },
      lockDays: { type: "number" },
      mode: { type: "string", enum: ["manual", "optimal"] },
      inputToken: { type: "string" },
      inputAmount: { type: "string" },
      stake: { type: "boolean" },
      op: { type: "string" },
      veBtcId: { type: "number" },
      veMezoId: { type: "number" },
      tokenId: { type: "number" },
      fromTokenId: { type: "number" },
      toTokenId: { type: "number" },
      to: { type: "string" },
      listingId: { type: "string" },
      everyHours: { type: "number" },
      occurrences: { type: "number" },
      enabled: { type: "boolean" },
      intoToken: { type: "string" },
      index: { type: "number" },
      question: { type: "string", description: "for action=clarify only" },
    },
    required: ["action"],
  },
} as const;
