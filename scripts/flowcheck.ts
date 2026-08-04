export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Dry-run every scored core flow against a REAL wallet, without signing.
 *
 * Each flow is built exactly as the bot builds it, then every step is simulated
 * with eth_call from the owner's address. This catches "it reverts" before a
 * human spends gas discovering it, and reports WHY - a gate, an unmet
 * precondition, or an on-chain revert.
 *
 *   MEZO_NETWORK=testnet npx tsx scripts/flowcheck.ts 0xYourAddress
 */
import { formatUnits, type Address } from "viem";
import { publicClient } from "../src/chain/client.js";
import { buildActionPlan } from "../src/surfaces/dispatch.js";
import { ActionUnavailableError } from "../src/surfaces/plan.js";
import { btcPriceUsd } from "../src/core/prices.js";

const owner = (process.argv[2] ?? "") as Address;
if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) { console.error("Pass a wallet address."); process.exit(1); }

const price = await btcPriceUsd();
const bal = await publicClient().getBalance({ address: owner });
console.log(`Wallet ${owner}`);
console.log(`BTC ${formatUnits(bal, 18)}  (~$${price ? (Number(formatUnits(bal, 18)) * price).toFixed(2) : "?"})\n`);

const FLOWS: Array<[string, any]> = [
  ["borrow",   { action: "borrow", mintMUSD: "1800", collateralBTC: "0.05" }],
  ["lock",     { action: "lock", asset: "BTC", amount: "0.001", lockDays: 28 }],
  ["claim",    { action: "claim", scope: "all" }],
  ["stakeLp",  { action: "stakeLp", pool: "BTC/MUSD" }],
  ["vote",     { action: "vote", tokenId: 1, optimal: true }],
];

for (const [name, intent] of FLOWS) {
  try {
    const plan = await buildActionPlan(intent, owner);
    if (!plan) { console.log(`${name.padEnd(9)} — no handler`); continue; }
    if (!plan.executable) { console.log(`${name.padEnd(9)} GATED    ${plan.gatedReason ?? ""}`.slice(0, 150)); continue; }
    let bad = 0;
    for (const st of plan.steps as any[]) {
      try { await publicClient().call({ account: owner, to: st.to, data: st.data, value: st.value }); }
      catch { bad++; }
    }
    console.log(`${name.padEnd(9)} ${bad === 0 ? "OK      " : "REVERTS "} ${plan.steps.length} step(s)${bad ? `, ${bad} revert (later steps often need an earlier one to land first)` : ""}`);
  } catch (e) {
    const msg = e instanceof ActionUnavailableError ? e.message : (e as Error).message;
    console.log(`${name.padEnd(9)} BLOCKED  ${msg}`.slice(0, 160));
  }
}
