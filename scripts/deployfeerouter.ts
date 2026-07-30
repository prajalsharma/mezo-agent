/**
 * Deploys FeeRouter (atomic swap+fee) to the configured network.
 *
 * Reuses the deploydelegate key pattern: the deployer key lives OUTSIDE the
 * repo (~/.mezo-agent-deploy/deployer.key, chmod 600). Run with no args to
 * print the deployer address for faucet funding; run with --deploy once funded.
 *
 *   MEZO_NETWORK=testnet npx tsx scripts/deployfeerouter.ts           # address
 *   MEZO_NETWORK=testnet npx tsx scripts/deployfeerouter.ts --deploy  # deploy
 *
 * Constructor wiring (all read from the live registry/env — never hardcoded):
 *   router            = registry Router
 *   feeRecipient      = AGENT_FEE_RECIPIENT (falls back to deployer for testnet trials)
 *   feeBps            = AGENT_FEE_BPS (default 50 = 0.5%)
 *   maxReferralShare  = AGENT_REFERRAL_SHARE_PCT as bps of the fee (default 30% → 3000)
 */
import "./_testenv.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, formatEther, type Hex, type Address } from "viem";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { env } from "../src/config/env.js";
import { registry } from "../src/registry/registry.js";

const DIR = join(homedir(), ".mezo-agent-deploy");
const KEYFILE = join(DIR, "deployer.key");

function deployerKey(): Hex {
  if (!existsSync(KEYFILE)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const fresh = generatePrivateKey();
    writeFileSync(KEYFILE, fresh, { mode: 0o600 });
  }
  const dirMode = statSync(DIR).mode & 0o077;
  const fileMode = statSync(KEYFILE).mode & 0o077;
  if (dirMode !== 0 || fileMode !== 0) {
    throw new Error(`Refusing to use ${KEYFILE}: it (or its dir) is group/other-accessible. chmod 700 the dir and 600 the file.`);
  }
  const raw = readFileSync(KEYFILE, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${KEYFILE} is not a 0x + 64-hex private key. Delete it to regenerate.`);
  }
  return raw as Hex;
}

const pk = deployerKey();
const account = privateKeyToAccount(pk);
const c = publicClient();
const bal = await c.getBalance({ address: account.address });
console.log(`network : ${env.network} (chain ${chainFor(env.network).id})`);
console.log(`deployer: ${account.address}`);
console.log(`balance : ${formatEther(bal)} BTC`);

if (!registry.hasContract("Router")) {
  console.error("❌ Router is not configured in the registry for this network.");
  process.exit(1);
}
const router = registry.contract("Router");
const feeRecipient = (/^0x[0-9a-fA-F]{40}$/.test(env.fees.recipient) ? env.fees.recipient : account.address) as Address;
const feeBps = env.fees.swapBps > 0 ? env.fees.swapBps : 50;
const maxReferralShareBps = Math.min(env.fees.referralSharePct, 100) * 100; // % of fee → bps of fee

console.log(`router          : ${router}`);
console.log(`feeRecipient    : ${feeRecipient}${feeRecipient === account.address ? " (deployer fallback — set AGENT_FEE_RECIPIENT for prod)" : ""}`);
console.log(`feeBps          : ${feeBps} (${feeBps / 100}%)`);
console.log(`maxReferralShare: ${maxReferralShareBps} bps of the fee`);

if (!process.argv.includes("--deploy")) {
  console.log(`\nFund this address (testnet: https://faucet.test.mezo.org/), then re-run with --deploy.`);
  process.exit(0);
}
if (bal === 0n) {
  console.error("\n❌ Deployer has no balance — fund it first.");
  process.exit(1);
}

const chain = chainFor(env.network);
console.log(`\nDeploying FeeRouter…`);
// SECURITY: deploy via viem from the compiled artifact bytecode; the key never
// touches a command line. forge only compiles.
execFileSync("forge", ["build"], {
  cwd: "contracts", stdio: "ignore",
  env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
});
const artifactPath = join(process.cwd(), "contracts", "out", "FeeRouter.sol", "FeeRouter.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;
const abi = artifact.abi;

const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
const hash = await wallet.deployContract({ abi, bytecode, args: [router, feeRecipient, feeBps, maxReferralShareBps] });
console.log(`tx        : ${hash}`);
const receipt = await c.waitForTransactionReceipt({ hash });
const addr = receipt.contractAddress!;
console.log(`deployedTo: ${addr}`);

const code = await c.getCode({ address: addr });
console.log(`code      : ${code ? (code.length - 2) / 2 : 0} bytes on-chain ${code && code !== "0x" ? "✅" : "❌"}`);

// Sanity-read the config back.
const readBps = await c.readContract({ address: addr, abi, functionName: "feeBps" });
const readRecipient = await c.readContract({ address: addr, abi, functionName: "feeRecipient" });
console.log(`verify    : feeBps=${readBps}, feeRecipient=${readRecipient}`);
console.log(`\nSet in env / Railway:\n  FEE_ROUTER_ADDRESS=${addr}`);
