/**
 * Deploys SessionKeyDelegate to the configured network.
 *
 * The deployer key lives OUTSIDE the repo (~/.mezo-agent-deploy/deployer.key,
 * chmod 600) so it can never be committed. Run with no args to (create and)
 * print the deployer address for faucet funding; run with --deploy once funded.
 *
 *   MEZO_NETWORK=testnet npx tsx scripts/deploydelegate.ts           # address
 *   MEZO_NETWORK=testnet npx tsx scripts/deploydelegate.ts --deploy  # deploy
 */
import "./_testenv.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther, type Hex } from "viem";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { env } from "../src/config/env.js";

const DIR = join(homedir(), ".mezo-agent-deploy");
const KEYFILE = join(DIR, "deployer.key");

function deployerKey(): Hex {
  if (!existsSync(KEYFILE)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const pk = generatePrivateKey();
    writeFileSync(KEYFILE, pk, { mode: 0o600 });
  }
  return readFileSync(KEYFILE, "utf8").trim() as Hex;
}

const pk = deployerKey();
const account = privateKeyToAccount(pk);
const c = publicClient();
const bal = await c.getBalance({ address: account.address });
console.log(`network : ${env.network} (chain ${chainFor(env.network).id})`);
console.log(`deployer: ${account.address}`);
console.log(`balance : ${formatEther(bal)} BTC`);

if (!process.argv.includes("--deploy")) {
  console.log(`\nFund this address (testnet: https://faucet.test.mezo.org/), then re-run with --deploy.`);
  process.exit(0);
}
if (bal === 0n) {
  console.error("\n❌ Deployer has no balance — fund it first.");
  process.exit(1);
}

const rpc = chainFor(env.network).rpcUrls.default.http[0]!;
console.log(`\nDeploying SessionKeyDelegate via forge…`);
const out = execFileSync(
  "forge",
  ["create", "src/SessionKeyDelegate.sol:SessionKeyDelegate", "--rpc-url", rpc, "--private-key", pk, "--broadcast", "--json"],
  { cwd: "contracts", encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` } },
);
const parsed = JSON.parse(out.split("\n").filter(Boolean).at(-1)!);
const addr = parsed.deployedTo as string;
console.log(`deployedTo: ${addr}`);
console.log(`tx        : ${parsed.transactionHash}`);

const code = await c.getCode({ address: addr as Hex });
console.log(`code      : ${code ? (code.length - 2) / 2 : 0} bytes on-chain ✅`);
console.log(`\nSet in env:\n  DELEGATE7702_ADDRESS=${addr}`);
