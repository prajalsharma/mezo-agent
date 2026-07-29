/**
 * Executability audit: builds every phase surface and reports whether it can
 * actually sign, or is preview-only and why. This is the check that turns a
 * "✅ implemented" checklist into "✅ operational" evidence.
 *   MEZO_NETWORK=mainnet npx tsx scripts/phaseaudit.ts
 */
import "./_testenv.js";
import { buildActionPlan } from "../src/surfaces/dispatch.js";
import { registry } from "../src/registry/registry.js";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const cases: [string, string, any][] = [
  ["P2", "Borrow (open Trove)", { action: "borrow", mintMUSD: "5000", collateralBTC: "0.5" }],
  ["P2", "Repay",               { action: "repay", repayMUSD: "1000" }],
  ["P2", "Adjust collateral",   { action: "adjust", addCollateralBTC: "0.1" }],
  ["P2", "Close Trove",         { action: "closeTrove" }],
  ["P2", "Vault deposit",       { action: "vaultDeposit", token: "MUSD", amount: "100" }],
  ["P2", "Stake LP",            { action: "stakeLp", pool: "MUSD/mUSDC" }],
  ["P2", "Unstake LP",          { action: "unstakeLp", pool: "MUSD/mUSDC" }],
  ["P2", "Claim rewards",       { action: "claim", scope: "all" }],
  ["P3", "Lock veBTC",          { action: "lock", asset: "BTC", amount: "0.2", lockDays: 28 }],
  ["P3", "Lock veMEZO",         { action: "lock", asset: "MEZO", amount: "1000", lockDays: 365 }],
  ["P3", "Extend lock",         { action: "extendLock", tokenId: "1", addDays: 30 }],
  ["P3", "Vote (optimal)",      { action: "vote", mode: "optimal" }],
  ["P3", "Vote (manual)",       { action: "vote", mode: "manual", tokenId: "1", weights: { "MUSD/mUSDC": 6000, "BTC/MUSD": 4000 } }],
  ["P3", "Market browse",       { action: "marketBrowse" }],
  ["P3", "Market buy",          { action: "marketBuy", listingId: "42" }],
  ["P4", "Zap into pool",       { action: "zap", inputToken: "BTC", inputAmount: "0.01", pool: "BTC/MUSD", stake: true }],
  ["P4", "Matchbox pair",       { action: "matchbox", op: "pair" }],
  ["P4", "veNFT transfer",      { action: "veTransfer", tokenId: "1", to: OWNER }],
  ["P4", "veNFT merge",         { action: "veMerge", fromTokenId: "1", toTokenId: "2" }],
];

const net = process.env.MEZO_NETWORK ?? "testnet";
console.log(`\n===== EXECUTABILITY AUDIT — ${net} =====\n`);
let exec = 0, gated = 0, err = 0, live = 0;
for (const [ph, name, intent] of cases) {
  try {
    const p: any = await buildActionPlan(intent as any, OWNER as any);
    if (p.executable) { exec++; console.log(`${ph} ✅ EXECUTABLE  ${name.padEnd(20)} ${p.steps.length} step(s) → ${p.steps.map((s: any) => s.to).join(", ").slice(0, 46)}`); }
    else { gated++; console.log(`${ph} 🔒 preview     ${name.padEnd(20)} ${String(p.gatedReason).slice(0, 62)}`); }
  } catch (e: any) {
    // A refusal computed from LIVE on-chain state (empty balance, no gauge,
    // nothing to claim) proves execution wiring — the surface read the chain
    // and correctly declined. Only unexpected errors count as failures.
    if (e?.constructor?.name === "ActionUnavailableError") {
      live++; console.log(`${ph} ✅ LIVE-check  ${name.padEnd(20)} refused: ${String(e.message).slice(0, 56)}`);
    } else { err++; console.log(`${ph} ❌ ERROR       ${name.padEnd(20)} ${e?.constructor?.name}: ${String(e.message).slice(0, 50)}`); }
  }
}
const pending = ["Router","Voter","VotingEscrowBTC","VotingEscrowMEZO","RewardsDistributor","Matchbox","Market","Delegate7702"].filter(k => !registry.hasContract(k as any));
console.log(`\n  EXECUTABLE=${exec}  live-checks=${live}  preview=${gated}  error=${err}`);
console.log(`  still awaiting addresses: ${pending.join(", ") || "(none)"}`);
