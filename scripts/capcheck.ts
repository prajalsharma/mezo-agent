export {};
/**
 * Is every per-token cap a REAL bound at that token's true decimals?
 *
 * The defect this guards: one 1e18-denominated fallback constant served every
 * token the hardcoded table did not name, so an 8-decimal asset got a "cap" of
 * ten trillion units — no cap at all. Decimals now come from the registry where
 * they are knowable, and where they are not the fallback assumes the SMALLEST
 * plausible decimals, so an unknown token fails closed rather than open.
 *
 *   npx tsx scripts/capcheck.ts
 */
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
import { formatUnits } from "viem";
import { tokenCapOf } from "../src/custody/policy.js";
const cases: Array<[string, number, string]> = [
  ["MUSD", 18, "registry, 18-dec stable"],
  ["mUSDC", 6, "registry, 6-dec stable"],
  ["MEZO", 18, "registry, 18-dec gov"],
  ["mcbBTC", 8, "NOT in registry, 8-dec BTC wrapper — the L5 case"],
  ["mFBTC", 8, "NOT in registry, 8-dec"],
  ["BTC/MUSD LP", 18, "LP share (contains 'BTC' but is not BTC)"],
  ["WEIRD", 18, "wholly unknown"],
];
let bad = 0;
for (const [sym, realDec, note] of cases) {
  const cap = tokenCapOf(undefined, sym);
  const human = Number(formatUnits(cap, realDec));
  // "No cap" means the limit is so large it can never bind. Anything over a
  // billion units of a real asset is not a cap.
  const meaningful = human > 0 && human <= 1_000_000;
  if (!meaningful) bad++;
  console.log(`  ${meaningful ? "✓" : "✗"} ${sym.padEnd(12)} -> ${human.toLocaleString()} ${sym}   (${note})`);
}
console.log(bad === 0 ? "\nEvery cap is a real bound at the token's true decimals. ✅" : `\n${bad} cap(s) are not real bounds ✗`);
process.exit(bad === 0 ? 0 : 1);
