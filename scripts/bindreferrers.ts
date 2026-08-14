export {};
/**
 * Sync the bot's off-chain referral links onto the FeeRouter, and allowlist the
 * tokens the fee may be charged in.
 *
 *   MEZO_NETWORK=testnet FEE_ROUTER_ADDRESS=0x… npx tsx scripts/bindreferrers.ts [--apply]
 *
 * Why this exists (audit): the FeeRouter pays a referrer only when
 * referrerOf[trader] == referrer, and charges the fee only in an allowlisted
 * token. Both registries ship EMPTY. Until this runs:
 *   - referred trades pay full price and referrers are paid nothing on-chain
 *     (the bot now detects this and stops quoting a discount, so nothing is
 *     mispriced - but nobody earns either);
 *   - the fee token allowlist is unconfigured, so the fee can be paid in any
 *     token, including a worthless one the caller minted.
 * Run it after every deploy, and whenever new users sign up through a link.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createWalletClient, http, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "./_testenv.js";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { env } from "../src/config/env.js";
import { registry } from "../src/registry/registry.js";
import { feeRouterAbi } from "../src/abis/router.js";
import { store } from "../src/db/store.js";
import { getUser } from "../src/wallet/walletService.js";

const ownerAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeTokenCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // The LATCH is what _swap branches on; feeTokenCount is never read on-chain.
  // Older deployments predate it, hence the catch at every call site.
  { type: "function", name: "feeTokenGateEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

const address = (process.env.FEE_ROUTER_ADDRESS ??
  (registry.hasContract("FeeRouter") ? registry.contract("FeeRouter") : "")) as Address;
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("Set FEE_ROUTER_ADDRESS.");
  process.exit(1);
}

const c = publicClient();
const owner = (await c.readContract({ address, abi: ownerAbi, functionName: "owner" })) as string;
const feeTokenCount = await c.readContract({ address, abi: ownerAbi, functionName: "feeTokenCount" });

// Group traders by the referrer they belong to; bindReferrers takes one
// referrer and many traders, so one tx per referrer covers their whole downline.
const byReferrer = new Map<string, Address[]>();
let unresolved = 0;
for (const telegramId of store.allTelegramIds()) {
  const referrerId = store.referrerOf(telegramId);
  if (referrerId === undefined) continue;
  const trader = getUser(telegramId);
  const referrer = getUser(referrerId);
  if (!trader || !referrer) { unresolved++; continue; }
  if (trader.address.toLowerCase() === referrer.address.toLowerCase()) continue; // self-referral
  const list = byReferrer.get(referrer.address) ?? [];
  list.push(trader.address as Address);
  byReferrer.set(referrer.address, list);
}

// Only bind pairs the chain doesn't already have, so re-running is cheap.
const pending = new Map<string, Address[]>();
for (const [referrer, traders] of byReferrer) {
  const missing: Address[] = [];
  for (const t of traders) {
    const cur = (await c.readContract({ address, abi: feeRouterAbi, functionName: "referrerOf", args: [t] })) as string;
    if (cur.toLowerCase() !== referrer.toLowerCase()) missing.push(t);
  }
  if (missing.length) pending.set(referrer, missing);
}

// ROUTING addresses, not `.address`.
//
// Two bugs in one map(). The fee is charged on `routes[0].from`, and swaps set
// that to `registry.routingAddress(tokenIn)` — for BTC that is the precompile
// 0x7b7C…0000, NOT its `.address`, which is the zero sentinel. So:
//   1. `t.address` put address(0) in the batch, and setFeeTokens reverts the
//      WHOLE batch on a zero entry — meaning this transaction could never land
//      and `feeTokenGateEnabled` has never been true in production. The one
//      control that stops the fee being denominated in an attacker-minted dust
//      token was silently off, and the script printed a warning saying so while
//      sending a transaction that could not fix it.
//   2. Even with the revert gone, allowlisting `.address` would leave the BTC
//      precompile off the list, and then every BTC-input swap would revert
//      FeeTokenNotAllowed — arming the gate would have broken the main asset.
const feeTokens = registry.allTokens().map((t) => registry.routingAddress(t));

console.log(`FeeRouter ${address} on ${env.network}`);
console.log(`owner            : ${owner}`);
console.log(`referral pairs   : ${[...byReferrer.values()].flat().length} known, ${[...pending.values()].flat().length} to bind`);
if (unresolved) console.log(`  (${unresolved} skipped: referrer or trader has no wallet yet)`);
console.log(`fee tokens       : ${feeTokenCount} on-chain, ${feeTokens.length} in the registry`);
// Report the LATCH, not the counter. feeTokenGateEnabled is what _swap actually
// branches on; feeTokenCount is never read on-chain. They disagree after the
// last token is removed (count 0, latch still true = everything reverts), and
// the old line reported that state as "the fee can be paid in ANY token" — the
// exact inverse of the truth.
const gateArmed = (await c.readContract({
  address, abi: ownerAbi, functionName: "feeTokenGateEnabled",
}).catch(() => false)) as boolean;
console.log(`fee-token gate   : ${gateArmed ? "ARMED" : "OFF"} (${feeTokenCount} token(s) allowed)`);
if (!gateArmed) {
  console.log("⚠️  fee-token allowlist is NOT armed: the fee can currently be paid in ANY token,");
  console.log("    including one an attacker mints. Run with --apply to arm it.");
} else if (feeTokenCount === 0n) {
  console.log("🛑 gate ARMED but ZERO tokens allowed: every swap through the FeeRouter reverts.");
  console.log("   Re-add the routing addresses with --apply.");
}

if (!process.argv.includes("--apply")) {
  console.log("\nDry run - re-run with --apply to send the transactions.");
  process.exit(0);
}

const pk = readFileSync(join(homedir(), ".mezo-agent-deploy/deployer.key"), "utf8").trim() as Hex;
const account = privateKeyToAccount(pk);
if (account.address.toLowerCase() !== owner.toLowerCase()) {
  console.error(`❌ Deployer key ${account.address} is not the owner (${owner}).`);
  process.exit(1);
}
const chain = chainFor(env.network);
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

/**
 * Send and CONFIRM. Every write here passed an explicit `gas`, which makes viem
 * skip eth_estimateGas — so a call that reverts is still submitted — and the
 * receipt was awaited but its `status` discarded. A reverting setFeeTokens
 * therefore printed a tx hash and then "✅ synced", and the operator had no
 * signal at all that the fee-token gate was still wide open. Anything that
 * reverts must now stop the script.
 */
async function send(label: string, functionName: "setFeeTokens" | "bindReferrers", args: readonly unknown[]) {
  const hash = await wallet.writeContract({
    address, abi: feeRouterAbi, functionName, args: args as never, gas: 500_000n,
  });
  console.log(`${label} tx:`, hash);
  const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000, retryCount: 8 });
  if (receipt.status !== "success") {
    console.error(`❌ ${label} REVERTED (${hash}). Nothing downstream was applied.`);
    process.exit(1);
  }
  return receipt;
}

if (!gateArmed && feeTokens.length) {
  await send("setFeeTokens", "setFeeTokens", [feeTokens, true]);
}

for (const [referrer, traders] of pending) {
  await send(`bindReferrers(${traders.length} traders -> ${referrer})`, "bindReferrers", [traders, referrer as Address]);
}

// Re-read rather than assume: the whole point of this script is that the gate
// ends up ARMED, and the previous version reported success without checking.
const armedAfter = (await c.readContract({
  address, abi: ownerAbi, functionName: "feeTokenGateEnabled",
}).catch(() => false)) as boolean;
console.log(armedAfter ? "✅ synced - fee-token gate is ARMED." : "⚠️  synced, but the fee-token gate is still OFF.");
