import { formatEther, parseEther, parseUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";

/**
 * Spending policy — the bounty requires "spending limits and confirmation
 * thresholds so a compromised session cannot drain an account."
 *
 * Hard caps on BTC value moved per transaction and per rolling 24h window, plus
 * per-token raw-amount caps, all enforced in the signer (defense in depth: the
 * signer refuses to sign an over-cap tx even if every other layer is bypassed),
 * plus a watch-only mode.
 *
 * CRITICAL on Mezo: native BTC is spent through its ERC-20 precompile
 * (WRAPPED_NATIVE_ADDRESS), so a BTC-moving transaction carries `value: 0n` and
 * the BTC amount lives in calldata. The signer therefore must treat approvals /
 * transfers of the BTC precompile as native spend — measuring only `msg.value`
 * would leave every lock/swap/zap/vault/stake uncapped. (Audit R2 C1.)
 *
 * Amounts are stored as decimal strings (wei) because JSON cannot hold bigint.
 */
export type SpendingLimits = {
  /** Max BTC (wei) movable in a single transaction (native OR via precompile). */
  perTxNativeWei: string;
  /** Max BTC (wei) movable within any rolling 24h window. */
  dailyNativeWei: string;
  /** BTC value (wei) above which the UI requires a step-up confirmation. */
  confirmationThresholdNativeWei: string;
  /**
   * Per-transaction caps on ERC-20 amounts, keyed by token symbol, as raw
   * (smallest-unit) decimal strings. Enforced in the signer. Ships with
   * conservative defaults so the cap is never silently absent (Audit R2 H8);
   * settable via `/limits token <SYMBOL> <amount>`.
   */
  perTxTokenCaps: Record<string, string>;
};

/**
 * Conservative per-token defaults so an ERC-20 outbound plan is never uncapped.
 *
 * DECIMALS COME FROM THE REGISTRY, NOT FROM A HARDCODED TABLE. The table only
 * named four symbols, and everything else fell back to a cap denominated in
 * 1e18 — so an 8-decimal token got a cap of 1e21 raw, i.e. ten trillion tokens,
 * which is no cap at all. The registry already knows every token's real
 * decimals; asking it means a token added later is capped correctly on the day
 * it is added rather than the day someone remembers this table exists.
 *
 * The HUMAN size is chosen by what the token is worth, not by its symbol:
 * BTC-denominated assets are capped like BTC (a few units), dollar-denominated
 * ones in thousands. Getting that backwards is how a 0.05 BTC limit once became
 * 12,500 mcbBTC in the delegate.
 */
const TOKEN_DEFAULT_HUMAN: Record<string, string> = {
  MUSD: "10000", mUSDC: "10000", mUSDT: "10000", MEZO: "100000",
};
/** Human-unit fallback for a token the table does not name, by denomination. */
const FALLBACK_HUMAN_BTC_DENOMINATED = "1";
const FALLBACK_HUMAN_OTHER = "1000";
/** LP shares are pool claims, not the asset in their name. Matches the old cap. */
const FALLBACK_HUMAN_LP = "1000";

/** Is this symbol denominated in BTC (so ~1 unit ≈ 1 BTC, not ≈ $1)? */
function isBtcDenominated(symbol: string): boolean {
  return /btc/i.test(symbol);
}

/** Velodrome LP shares. Always 18-decimal, and NOT priced like their pair. */
function isLpShare(symbol: string): boolean {
  return /\bLP\b/i.test(symbol);
}

/**
 * The smallest decimals any real token is likely to use.
 *
 * For a symbol whose decimals we genuinely do NOT know, a raw cap has to be
 * computed against SOME assumption, and the only safe one is the smallest:
 * a raw number sized for 6 decimals is conservative if the token turns out to
 * have 8 or 18, whereas one sized for 18 is "no cap" for anything smaller.
 * That asymmetry is the whole bug — a single 1e18-denominated constant meant an
 * 8-decimal token could move ten trillion units.
 */
const UNKNOWN_DECIMALS_ASSUMPTION = 6;

/**
 * Raw per-tx cap for a symbol, in ITS OWN decimals wherever those are knowable.
 *
 * Exported for tests. Three cases, in order:
 *   1. a REGISTRY token — exact decimals, sized by what it is worth,
 *   2. an LP share — 18 decimals by construction, sized as a pool share rather
 *      than as the BTC in its name (a "BTC/MUSD LP" symbol contains "BTC" but is
 *      not denominated in BTC),
 *   3. genuinely unknown — fail CLOSED at the smallest plausible decimals, so
 *      the cap can never silently become unlimited. It is deliberately tight;
 *      `/limits token <SYM> <amount>` is the way to widen it deliberately.
 */
export function unknownTokenCapRaw(symbol: string): string {
  const t = registry.tryToken(symbol);
  if (t) return parseUnits(defaultHumanFor(symbol), t.decimals).toString();
  if (isLpShare(symbol)) return parseUnits(FALLBACK_HUMAN_LP, 18).toString();
  return parseUnits(FALLBACK_HUMAN_OTHER, UNKNOWN_DECIMALS_ASSUMPTION).toString();
}

/** Human-unit default cap for a symbol whose decimals are known. */
function defaultHumanFor(symbol: string): string {
  if (TOKEN_DEFAULT_HUMAN[symbol]) return TOKEN_DEFAULT_HUMAN[symbol]!;
  if (isLpShare(symbol)) return FALLBACK_HUMAN_LP;
  return isBtcDenominated(symbol) ? FALLBACK_HUMAN_BTC_DENOMINATED : FALLBACK_HUMAN_OTHER;
}

function defaultTokenCaps(): Record<string, string> {
  const out: Record<string, string> = {};
  // Every registry token gets an explicit cap in its own decimals, so nothing
  // depends on the fallback in normal operation.
  for (const t of registry.allTokens()) {
    if (t.native) continue; // native BTC is bounded by the native caps
    out[t.symbol] = parseUnits(defaultHumanFor(t.symbol), t.decimals).toString();
  }
  // Keep any named default the registry does not carry on this network. Their
  // decimals are unknowable here, so use the same fail-closed assumption.
  for (const sym of Object.keys(TOKEN_DEFAULT_HUMAN)) {
    out[sym] ??= unknownTokenCapRaw(sym);
  }
  return out;
}

/**
 * Per-tx raw-amount cap for a token symbol. Never returns undefined: an unknown
 * token gets the conservative fallback, so the signer's ERC-20 branch is always
 * live (Audit R2 H8 — previously this returned undefined for every call because
 * no code path populated perTxTokenCaps).
 */
export function tokenCapOf(limits: SpendingLimits | undefined, symbol: string): bigint {
  const caps = limitsOf(limits).perTxTokenCaps;
  const raw = caps[symbol];
  // The fallback is computed FOR THIS SYMBOL, in its own decimals — a single
  // 1e18-denominated constant was "no cap" for anything with fewer.
  return BigInt(raw ?? unknownTokenCapRaw(symbol));
}

/**
 * How many multiples of the per-transaction cap a token may move in 24 hours.
 *
 * There was no aggregate window for ERC-20s at all — the per-tx cap bound each
 * swap individually and nothing bound the sequence. That is the gap unattended
 * automation lives in: an hourly DCA is twenty-four separately-legal
 * transactions, and only their total is alarming. A multiplier (rather than a
 * second number to configure) means tightening the per-tx cap tightens the day
 * too, which is what someone reaching for /limits actually intends.
 */
export const DAILY_TOKEN_CAP_MULTIPLE = 5n;

/** Rolling-24h raw-amount cap for a token symbol. */
export function dailyTokenCapOf(limits: SpendingLimits | undefined, symbol: string): bigint {
  return tokenCapOf(limits, symbol) * DAILY_TOKEN_CAP_MULTIPLE;
}

export const DEFAULT_LIMITS: SpendingLimits = {
  perTxNativeWei: parseEther("0.05").toString(),
  dailyNativeWei: parseEther("0.2").toString(),
  confirmationThresholdNativeWei: parseEther("0.02").toString(),
  perTxTokenCaps: defaultTokenCaps(),
};

export function limitsOf(limits: SpendingLimits | undefined): SpendingLimits {
  // Merge so a legacy record persisted before perTxTokenCaps existed still gets
  // the defaults rather than an empty (fail-open) map.
  if (!limits) return DEFAULT_LIMITS;
  return {
    ...limits,
    perTxTokenCaps: { ...defaultTokenCaps(), ...(limits.perTxTokenCaps ?? {}) },
  };
}

export function fmtBtc(wei: string | bigint): string {
  return `${formatEther(typeof wei === "bigint" ? wei : BigInt(wei))} BTC`;
}

/** The BTC ERC-20 precompile — an approval/transfer here is a native BTC spend. */
export const BTC_PRECOMPILE = "0x7b7C000000000000000000000000000000000000" as Address;
