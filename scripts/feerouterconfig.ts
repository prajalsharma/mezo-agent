export {};
/**
 * Update the deployed FeeRouter's on-chain config (owner = deployer key).
 *
 *   MEZO_NETWORK=testnet FEE_ROUTER_ADDRESS=0x… npx tsx scripts/feerouterconfig.ts \
 *     [--recipient 0x…] [--fee-bps 50] [--max-referral-pct 30] [--apply]
 *
 * Without --apply it prints current vs proposed config. Keep the on-chain values
 * in sync with the bot env (AGENT_FEE_BPS / AGENT_REFERRAL_SHARE_PCT): the bot
 * always passes explicit per-call overrides, but the contract CLAMPS the
 * referral share at maxReferralShareBps — raising the env % without raising the
 * on-chain max silently pays referrers less than advertised (audit finding).
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

const abi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "maxReferralShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "setConfig", stateMutability: "nonpayable",
    inputs: [{ name: "feeRecipient_", type: "address" }, { name: "feeBps_", type: "uint16" }, { name: "maxReferralShareBps_", type: "uint16" }], outputs: [] },
] as const;

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const address = (process.env.FEE_ROUTER_ADDRESS ?? (registry.hasContract("FeeRouter") ? registry.contract("FeeRouter") : "")) as Address;
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { console.error("Set FEE_ROUTER_ADDRESS."); process.exit(1); }

const c = publicClient();
const [owner, curRecipient, curBps, curMax] = await Promise.all([
  c.readContract({ address, abi, functionName: "owner" }),
  c.readContract({ address, abi, functionName: "feeRecipient" }),
  c.readContract({ address, abi, functionName: "feeBps" }),
  c.readContract({ address, abi, functionName: "maxReferralShareBps" }),
]);

const newRecipient = (arg("--recipient") ?? curRecipient) as Address;
const newBps = Number(arg("--fee-bps") ?? curBps);
const newMax = Number(arg("--max-referral-pct") ?? Number(curMax) / 100) * 100;

console.log(`FeeRouter ${address} on ${env.network}`);
console.log(`owner            : ${owner}`);
console.log(`feeRecipient     : ${curRecipient} -> ${newRecipient}`);
console.log(`feeBps           : ${curBps} -> ${newBps}`);
console.log(`maxReferralShare : ${curMax} -> ${newMax} bps of the fee`);
console.log(`bot env          : AGENT_FEE_BPS=${env.fees.swapBps}, AGENT_REFERRAL_SHARE_PCT=${env.fees.referralSharePct}`);
if (newBps !== env.fees.swapBps) console.log("⚠️  feeBps differs from AGENT_FEE_BPS (bot overrides per-call; keep them equal for clarity).");
if (newMax < env.fees.referralSharePct * 100) console.log("❌ maxReferralShare would CLAMP the advertised referral share — raise it or lower the env %.");

if (!process.argv.includes("--apply")) { console.log("\nDry run — re-run with --apply to send setConfig."); process.exit(0); }

const pk = readFileSync(join(homedir(), ".mezo-agent-deploy/deployer.key"), "utf8").trim() as Hex;
const account = privateKeyToAccount(pk);
if (account.address.toLowerCase() !== (owner as string).toLowerCase()) {
  console.error(`❌ Deployer key ${account.address} is not the owner (${owner}).`); process.exit(1);
}
const chain = chainFor(env.network);
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
const hash = await wallet.writeContract({ address, abi, functionName: "setConfig", args: [newRecipient, newBps, newMax], gas: 200_000n });
console.log("setConfig tx:", hash);
await c.waitForTransactionReceipt({ hash, timeout: 120_000, retryCount: 8 });
console.log("✅ applied. New config:", {
  feeRecipient: await c.readContract({ address, abi, functionName: "feeRecipient" }),
  feeBps: await c.readContract({ address, abi, functionName: "feeBps" }),
  maxReferralShareBps: await c.readContract({ address, abi, functionName: "maxReferralShareBps" }),
});
