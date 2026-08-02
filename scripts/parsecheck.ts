/**
 * Parsing audit — exercises the DETERMINISTIC parser (the layer that must work
 * with zero LLM dependence) against a battery of realistic user phrasings for
 * every basic functionality. Run: `node --import tsx scripts/parsecheck.ts`.
 *
 * This is the reliability floor: whatever the LLM does, these headline commands
 * must always parse. Symbol aliasing (USDC->mUSDC) is covered too.
 */
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
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
  // Adjust Trove — the tip card teaches these exact phrasings; they used to all
  // fall through to "I didn't catch that".
  { msg: "add 0.05 BTC collateral",  want: { action: "adjust", addCollateralBTC: "0.05" } },
  { msg: "withdraw 0.02 BTC",        want: { action: "adjust", withdrawCollateralBTC: "0.02" } },
  { msg: "mint 500 MUSD",            want: { action: "adjust", mintMUSD: "500" } },
  { msg: "Add 0.05 btc collateral withdraw 0.02 BTC and mint 500 musd",
    want: { action: "adjust", addCollateralBTC: "0.05", withdrawCollateralBTC: "0.02", mintMUSD: "500" } },

  // ── Lock (days / weeks / years) ───────────────────────────────────────────
  { msg: "lock 0.2 BTC for 28 days",   want: { action: "lock", asset: "BTC", amount: "0.2", lockDays: 28 } },
  { msg: "lock 1000 MEZO for 2 years", want: { action: "lock", asset: "MEZO", amount: "1000", lockDays: 730 } },
  // Duration phrasings users actually type — MONTHS and bare articles were
  // missing, so "lock 0.2 BTC for 6 months" hit "I didn't catch that".
  { msg: "Lock 0.2 btc for 6 months",   want: { action: "lock", asset: "BTC", amount: "0.2", lockDays: 180 } },
  { msg: "lock 0.02 btc for 1 month",   want: { action: "lock", asset: "BTC", amount: "0.02", lockDays: 30 } },
  { msg: "lock 1000 mezo for 18 months",want: { action: "lock", asset: "MEZO", amount: "1000", lockDays: 540 } },
  { msg: "lock 0.01 btc for a week",    want: { action: "lock", asset: "BTC", amount: "0.01", lockDays: 7 } },
  { msg: "stake 0.1 btc for 30 days",   want: { action: "lock", asset: "BTC", amount: "0.1", lockDays: 30 } },
  { msg: "extend lock 3 by 2 months",   want: { action: "extendLock", tokenId: 3, addDays: 60 } },

  // ── DCA / automation ──────────────────────────────────────────────────────
  { msg: "dca 50 MUSD to BTC every 24h", want: { action: "dcaCreate", fromToken: "MUSD", toToken: "BTC", amount: "50", everyHours: 24 } },
  { msg: "auto-compound on",             want: { action: "autoCompound", enabled: true } },

  // ── Zap / stake LP ────────────────────────────────────────────────────────
  { msg: "zap 0.01 BTC into MUSD/mUSDC", want: { action: "zap", inputToken: "BTC", inputAmount: "0.01", pool: "MUSD/MUSDC" } },
  { msg: "stake LP MUSD/mUSDC",          want: { action: "stakeLp", pool: "MUSD/MUSDC" } },
  // Dead-end audit regressions: capabilities that had NO parser rule, so users
  // could never reach them by typing (two were taught by tip cards).
  { msg: "deposit 100 MUSD into vault", want: { action: "vaultDeposit", token: "MUSD", amount: "100" } },
  { msg: "extend lock 3 by 30 days",    want: { action: "extendLock", tokenId: 3, addDays: 30 } },
  { msg: "merge veNFT 1 into veNFT 2",  want: { action: "veMerge", fromTokenId: 1, toTokenId: 2 } },
  { msg: "transfer veNFT 1 to 0x1111111111111111111111111111111111111111",
    want: { action: "veTransfer", tokenId: 1 } },
  { msg: "pair veNFT 1 with veMEZO 2",  want: { action: "matchbox", op: "pair", veBtcId: 1, veMezoId: 2 } },

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
  // Questions must NOT be hijacked by the loose keyword rules — they belong to
  // GUIDE mode. (Regression: "should I vote this epoch?" used to EXECUTE a vote.)
  { msg: "should I vote this epoch?", want: { action: "clarify" } },
  { msg: "how do I claim rewards?", want: { action: "clarify" } },
  { msg: "is the market good right now?", want: { action: "clarify" } },
  { msg: "should I buy more btc?", want: { action: "clarify" } },
  { msg: "what are my positions?", want: { action: "clarify" } },
  // ...while the equivalent COMMANDS still parse deterministically.
  { msg: "vote optimally", want: { action: "vote" } },
  { msg: "claim all", want: { action: "claim" } },
  { msg: "close trove", want: { action: "closeTrove" } },
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
