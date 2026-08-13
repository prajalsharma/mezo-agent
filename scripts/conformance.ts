export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Does the agent still agree with the DEPLOYED protocol?
 *
 * Every number in the borrow surface used to be a compile-time constant, and the
 * constants had drifted: the borrowing fee was hardcoded at 1% against a live
 * 0.1%, and the 200 MUSD gas compensation that `openTrove` gates on was missing
 * from the debt entirely. The result was a card reading "110% ✅" for a Trove
 * really sitting at 99% that would revert, with a liquidation price up to 10%
 * optimistic — wrong in the direction that gets people liquidated.
 *
 * Constants cannot drift if there are none, so this asserts two things:
 *   1. every parameter is READ from the chain and is sane, and
 *   2. the debt arithmetic reproduces the protocol's own composite-debt rule.
 *
 * Run after any protocol upgrade or governance parameter change:
 *   MEZO_NETWORK=testnet npx tsx scripts/conformance.ts
 */
import { parseUnits, formatUnits } from "viem";
import {
  musdParams, compositeDebt, borrowingFee, maxNetMint, icrOf, liquidationPrice, pct,
} from "../src/core/musdParams.js";
import { btcPriceWad } from "../src/core/prices.js";
import { buildBorrow } from "../src/surfaces/borrow.js";
import { env } from "../src/config/env.js";

let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};

console.log(`Conformance against live ${env.network}\n`);

const p = await musdParams();
const price = await btcPriceWad();

ok("live borrowing parameters are readable", p !== undefined);
ok("live BTC price is readable (fetchPrice, not the phantom lastGoodPrice)", price !== undefined);
if (!p || price === undefined) {
  console.log("\nCannot continue without live values — this is itself the fail-closed behaviour. ✗");
  process.exit(1);
}

console.log(
  `\n  gasComp=${formatUnits(p.gasCompensation, 18)} MUSD   rate=${Number(p.borrowingRate) / 1e16}%   ` +
    `minNetDebt=${formatUnits(p.minNetDebt, 18)}   MCR=${pct(p.mcr)}   CCR=${pct(p.ccr)}   BTC=$${Math.round(Number(formatUnits(price, 18)))}\n`,
);

// Sanity bounds. These are NOT the expected values (that would just re-introduce
// the constants); they are the range outside which a read is certainly wrong.
ok("gas compensation is non-zero", p.gasCompensation > 0n, `${formatUnits(p.gasCompensation, 18)} MUSD`);
ok("borrowing rate is below 10%", p.borrowingRate < 10n ** 17n, `${Number(p.borrowingRate) / 1e16}%`);
ok("MCR is between 100% and 200%", p.mcr > 10n ** 18n && p.mcr < 2n * 10n ** 18n, pct(p.mcr));
ok("CCR is at least MCR", p.ccr >= p.mcr, `${pct(p.ccr)} >= ${pct(p.mcr)}`);
ok("minimum net debt is non-zero", p.minNetDebt > 0n, `${formatUnits(p.minNetDebt, 18)} MUSD`);

// The composite-debt rule: LiquityBase._getCompositeDebt(netDebt) = netDebt + gasComp,
// and BorrowerOperations adds the borrowing fee on top of the net mint.
const mint = parseUnits("1800", 18);
const debt = compositeDebt(mint, p, false);
const expected = mint + borrowingFee(mint, p, false) + p.gasCompensation;
ok("compositeDebt == mint + fee + gasCompensation", debt === expected, `${formatUnits(debt, 18)} MUSD`);
ok("compositeDebt includes gas compensation", debt - mint - borrowingFee(mint, p, false) === p.gasCompensation);
ok("Recovery Mode waives the borrowing fee", borrowingFee(mint, p, true) === 0n);
ok("Recovery Mode debt is still charged gas compensation", compositeDebt(mint, p, true) === mint + p.gasCompensation);

// maxNetMint must invert compositeDebt: minting exactly the headroom must land
// on the required ratio, never above it.
const coll = parseUnits("0.05", 18);
const headroom = maxNetMint(coll, price, p, false);
const atHeadroom = icrOf(coll, price, compositeDebt(headroom, p, false));
ok(
  "maxNetMint inverts compositeDebt (minting it lands at exactly MCR)",
  atHeadroom >= p.mcr - 10n ** 12n && atHeadroom <= p.mcr + 10n ** 12n,
  `${pct(atHeadroom)} vs MCR ${pct(p.mcr)}`,
);
ok("minting 1 MUSD above the headroom breaches MCR", icrOf(coll, price, compositeDebt(headroom + parseUnits("1", 18), p, false)) < p.mcr);

// The liquidation price must be priced off the RECORDED debt, not the net mint.
// Pricing it off the net mint is what made the warning up to 10% optimistic.
const liqTrue = liquidationPrice(coll, debt, p);
const liqIfNetOnly = liquidationPrice(coll, mint, p);
ok("liquidation price uses composite debt (higher than the net-mint figure)", liqTrue > liqIfNetOnly,
  `$${Math.round(Number(formatUnits(liqTrue, 18)))} vs the old $${Math.round(Number(formatUnits(liqIfNetOnly, 18)))}`);

// End-to-end: the exact collateral the OLD model called "exactly 110%" must now
// be refused, because its true ICR is under 100%.
const oldModelDebt = parseUnits("1818", 18); // 1,800 + the old hardcoded 1% fee
const oldModelColl = (oldModelDebt * p.mcr) / price;
const trueIcr = icrOf(oldModelColl, price, debt);
ok("the old model's 'exactly 110%' collateral is really under MCR", trueIcr < p.mcr, pct(trueIcr));
let refused = false;
try {
  await buildBorrow({ action: "borrow", collateralBTC: formatUnits(oldModelColl, 18).slice(0, 10), mintMUSD: "1800" } as never);
} catch { refused = true; }
ok("buildBorrow refuses it instead of showing a green card", refused);

// And a genuinely safe Trove still builds.
let built = false;
try {
  const plan = await buildBorrow({ action: "borrow", collateralBTC: "0.05", mintMUSD: "1800" } as never);
  built = plan.executable && plan.steps.length > 0;
  const shows = plan.summary.some((l) => /gas compensation/i.test(l));
  ok("the card discloses the gas compensation", shows);
  ok("the card warns about redemption ranking", plan.warnings.some((w) => /redemption/i.test(w)));
} catch (e) {
  ok("a well-collateralized borrow still builds", false, (e as Error).message.slice(0, 80));
}
ok("a well-collateralized borrow still builds", built);

console.log(fail === 0 ? "\nConformance OK - the agent agrees with the deployed protocol. ✅" : `\n${fail} CONFORMANCE FAILURE(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
