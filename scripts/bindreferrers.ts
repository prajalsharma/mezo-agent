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

const feeTokens = registry.allTokens().map((t) => t.address as Address);

console.log(`FeeRouter ${address} on ${env.network}`);
console.log(`owner            : ${owner}`);
console.log(`referral pairs   : ${[...byReferrer.values()].flat().length} known, ${[...pending.values()].flat().length} to bind`);
if (unresolved) console.log(`  (${unresolved} skipped: referrer or trader has no wallet yet)`);
console.log(`fee tokens       : ${feeTokenCount} on-chain, ${feeTokens.length} in the registry`);
if (feeTokenCount === 0n) console.log("⚠️  fee-token allowlist is EMPTY: the fee can currently be paid in ANY token.");

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

if (feeTokenCount === 0n && feeTokens.length) {
  const hash = await wallet.writeContract({
    address, abi: feeRouterAbi, functionName: "setFeeTokens", args: [feeTokens, true], gas: 500_000n,
  });
  console.log("setFeeTokens tx:", hash);
  await c.waitForTransactionReceipt({ hash, timeout: 120_000, retryCount: 8 });
}

for (const [referrer, traders] of pending) {
  const hash = await wallet.writeContract({
    address, abi: feeRouterAbi, functionName: "bindReferrers", args: [traders, referrer as Address], gas: 500_000n,
  });
  console.log(`bindReferrers(${traders.length} traders -> ${referrer}) tx:`, hash);
  await c.waitForTransactionReceipt({ hash, timeout: 120_000, retryCount: 8 });
}
console.log("✅ synced.");
