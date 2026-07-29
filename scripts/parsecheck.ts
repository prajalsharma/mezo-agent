/**
 * Parsing audit — exercises the DETERMINISTIC parser (the layer that must work
 * with zero LLM dependence) against a battery of realistic user phrasings for
 * every basic functionality. Run: `node --import tsx scripts/parsecheck.ts`.
 *
 * This is the reliability floor: whatever the LLM does, these headline commands
 * must always parse. Symbol aliasing (USDC->mUSDC) is covered too.
 */
import { fallbackParse, resolveSymbol } from "../src/llm/adapter.js";
import { Intent } from "../src/llm/intent.js";

// The real testnet symbol set (from src/registry/addresses.ts).
const SYMBOLS = [
  "BTC", "MUSD", "mUSDC", "mUSDT", "MEZO",
  "mcbBTC", "mFBTC", "mswBTC", "mSolvBTC", "mxSolvBTC", "mDAI", "mUSDe", "mT",
];

type Expect = Record<string, unknown> & { action: string };
const cases: { msg: string; want: Expect }[] = [
  // ── Swap (+ synonyms, arrows, aliasing) ───────────────────────────────────
  { msg: "Swap 0.0001 BTC to mUSDC", want: { action: "swap", amount: "0.0001", fromToken: "BTC", toToken: "mUSDC" } },
  { msg: "Swap 0.0001 BTC to USDC",  want: { action: "swap", amount: "0.0001", fromToken: "BTC", toToken: "mUSDC" } }, // alias
  { msg: "swap 100 musd for usdt",   want: { action: "swap", amount: "100", fromToken: "MUSD", toToken: "mUSDT" } },
  { msg: "trade 5 mezo into btc",    want: { action: "swap", amount: "5", fromToken: "MEZO", toToken: "BTC" } },
  { msg: "convert 0.5 btc -> musd",  want: { action: "swap", amount: "0.5", fromToken: "BTC", toToken: "MUSD" } },

  // ── Borrow / repay / trove ────────────────────────────────────────────────
  { msg: "borrow 500 MUSD against 0.1 BTC", want: { action: "borrow", mintMUSD: "500", collateralBTC: "0.1" } },
  { msg: "repay 200 musd",                  want: { action: "repay", repayMUSD: "200" } },
  { msg: "close trove",                     want: { action: "closeTrove" } },

  // ── Lock (days / weeks / years) ───────────────────────────────────────────
  { msg: "lock 0.2 BTC for 28 days",   want: { action: "lock", asset: "BTC", amount: "0.2", lockDays: 28 } },
  { msg: "lock 1000 MEZO for 2 years", want: { action: "lock", asset: "MEZO", amount: "1000", lockDays: 730 } },

  // ── DCA / automation ──────────────────────────────────────────────────────
  { msg: "dca 50 MUSD to BTC every 24h", want: { action: "dcaCreate", fromToken: "MUSD", toToken: "BTC", amount: "50", everyHours: 24 } },
  { msg: "auto-compound on",             want: { action: "autoCompound", enabled: true } },

  // ── Zap / stake LP ────────────────────────────────────────────────────────
  { msg: "zap 0.01 BTC into MUSD/mUSDC", want: { action: "zap", inputToken: "BTC", inputAmount: "0.01", pool: "MUSD/MUSDC" } },
  { msg: "stake LP MUSD/mUSDC",          want: { action: "stakeLp", pool: "MUSD/MUSDC" } },

  // ── Vote / claim / market ─────────────────────────────────────────────────
  { msg: "vote",           want: { action: "vote", mode: "optimal" } },
  { msg: "claim rewards",  want: { action: "claim", scope: "all" } },
  { msg: "browse market",  want: { action: "marketBrowse" } },

  // ── Read / account ────────────────────────────────────────────────────────
  { msg: "show my portfolio", want: { action: "portfolio" } },
  { msg: "balances",          want: { action: "portfolio" } },
  { msg: "create account",    want: { action: "account", op: "new" } },

  // ── Must defer to the LLM (rules correctly return clarify) ────────────────
  { msg: "what can I do with my btc?", want: { action: "clarify" } },
  { msg: "hi",                         want: { action: "clarify" } },
];

let pass = 0;
const fails: string[] = [];

for (const { msg, want } of cases) {
  const got = fallbackParse(msg, SYMBOLS) as Record<string, unknown>;
  // Every parsed intent must ALSO be schema-valid.
  if (want.action !== "clarify" && !Intent.safeParse(got).success) {
    fails.push(`"${msg}" → parsed but OFF-SCHEMA: ${JSON.stringify(got)}`);
    continue;
  }
  const mismatch = Object.entries(want).find(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
  if (mismatch) {
    fails.push(`"${msg}" → got ${JSON.stringify(got)} — wanted ${JSON.stringify(want)}`);
  } else {
    pass++;
  }
}

// Symbol-resolver spot checks.
const symCases: [string, string | undefined][] = [
  ["USDC", "mUSDC"], ["usdt", "mUSDT"], ["DAI", "mDAI"], ["cbBTC", "mcbBTC"],
  ["BTC", "BTC"], ["MUSD", "MUSD"], ["mezo", "MEZO"], ["nonsense", undefined],
];
for (const [inp, exp] of symCases) {
  const got = resolveSymbol(inp, SYMBOLS);
  if (got !== exp) fails.push(`resolveSymbol("${inp}") → ${got} — wanted ${exp}`);
  else pass++;
}

console.log(`\nPARSE AUDIT: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\n❌ FAILURES:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("✅ all basic functionalities parse correctly\n");
