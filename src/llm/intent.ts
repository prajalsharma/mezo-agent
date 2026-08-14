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
/**
 * Slippage tolerance, in percent.
 *
 * `minOut` is the ONLY value protection on the swap path, and this number sets
 * it — so an unbounded slippage is an unbounded loss, and the schema previously
 * admitted up to 50%. That made "swap with 50% slippage" the single
 * highest-leverage prompt-injection target in the app: one accepted intent and a
 * sandwicher could take half the trade. 5% is well above what any legitimate
 * trade on these pools needs; anything higher has to be a deliberate, typed
 * decision rather than something a model can pick.
 */
export const MAX_SLIPPAGE_PCT = 5;
const slippage = z.number().min(0.01).max(MAX_SLIPPAGE_PCT).optional();

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
/**
 * A redeemed or liquidated Trove can leave collateral in the surplus pool, and
 * the protocol never pushes it back — the borrower has to call for it. Without
 * this action the bot could describe redemption risk but leave the user with no
 * way to recover what they were owed.
 */
export const ClaimCollateralIntent = z.object({ action: z.literal("claimCollateral") });
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
  // Only an absurdity guard. The REAL bound belongs to the surface, which knows
  // which escrow the id lives on and can say "veBTC locks cap at 28 days". A
  // tight schema max here shadowed that: "extend by 5 years" returned
  // "Number must be less than or equal to 1460" — a number the user never typed,
  // about a limit that is not the real one.
  addDays: z.number().int().positive().max(100 * 365).optional(),
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

/**
 * Remap common cross-action field aliases onto the canonical names each Intent
 * expects, BEFORE Zod validation. The tool schema is one flat object shared by
 * all actions, so a model will sometimes fill a swap's source with the zap
 * fields (inputToken/inputAmount) or vice-versa. This deterministic normalizer
 * makes those loose-but-unambiguous replies parse instead of falling to clarify.
 * Unknown keys are harmless — Zod strips them.
 */
export function normalizeIntentFields(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  switch (o.action) {
    case "swap":
    case "dcaCreate":
      if (o.fromToken == null && o.inputToken != null) o.fromToken = o.inputToken;
      if (o.amount == null && o.inputAmount != null) o.amount = o.inputAmount;
      break;
    case "zap":
      if (o.inputToken == null && o.fromToken != null) o.inputToken = o.fromToken;
      if (o.inputAmount == null && o.amount != null) o.inputAmount = o.amount;
      break;
    case "vaultDeposit":
      if (o.token == null) o.token = o.inputToken ?? o.fromToken ?? o.token;
      if (o.amount == null && o.inputAmount != null) o.amount = o.inputAmount;
      break;
  }
  return o;
}

export const Intent = z.discriminatedUnion("action", [
  SwapIntent,
  BorrowIntent,
  RepayIntent,
  AdjustIntent,
  CloseTroveIntent,
  ClaimCollateralIntent,
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

export class IntentRejected extends Error {}

/**
 * THE choke point. Every intent must pass through here before it reaches a
 * surface, whatever produced it.
 *
 * The schema above is the codebase's strongest single guard — `amount` is
 * `z.coerce.string().regex(/^\d+(\.\d+)?$/)`, which defeats the whole
 * parse-divergence class (it rejects `1e30`, `0x10`, `" 5 "`, `5,000`, `1_000`,
 * `Infinity`, `NaN`, negatives and unicode digits, so `Number()` and
 * `parseUnits()` cannot disagree on anything it admits).
 *
 * But it was only ever applied on ONE of the three routes in. Inline-keyboard
 * callbacks string-split raw callback data and passed the fragments straight to
 * the surfaces, and the deterministic rule parser returned before validation.
 * Both of those now come through here, so there is no route that reaches a
 * builder without the schema having seen the values.
 */
export function validateIntent(candidate: unknown): Intent {
  const parsed = Intent.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
  throw new IntentRejected(
    `I couldn't act on that${where}: ${issue?.message ?? "it didn't match a known action"}. ` +
      `Amounts must be plain numbers like 0.05 or 1800.`,
  );
}

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
    "closeTrove, claimCollateral, vaultDeposit, stakeLp, unstakeLp, claim, lock, extendLock, vote, marketBrowse, " +
    "marketBuy, zap, matchbox, veTransfer, veMerge, dcaCreate, dcaCancel, autoCompound, account, " +
    "portfolio, clarify.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string" },
      amount: { type: "string", description: "plain number amount (no symbol) for swap/borrow/repay/lock/vaultDeposit/dca, e.g. \"0.05\"" },
      fromToken: { type: "string", description: "SWAP/DCA source token symbol (the token being sold)" },
      toToken: { type: "string", description: "SWAP/DCA destination token symbol (the token being bought)" },
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
      inputToken: { type: "string", description: "ZAP only: token supplied into the pool (for a swap use fromToken instead)" },
      inputAmount: { type: "string", description: "ZAP only: amount supplied into the pool (for a swap use amount instead)" },
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
