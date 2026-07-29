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
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, formatEther, type Hex } from "viem";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { env } from "../src/config/env.js";

const DIR = join(homedir(), ".mezo-agent-deploy");
const KEYFILE = join(DIR, "deployer.key");

function deployerKey(): Hex {
  if (!existsSync(KEYFILE)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const fresh = generatePrivateKey();
    writeFileSync(KEYFILE, fresh, { mode: 0o600 });
  }
  // Reject a directory/file whose perms are looser than owner-only — mkdir's
  // mode only applies at creation, so a pre-existing loose dir must be caught.
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

if (!process.argv.includes("--deploy")) {
  console.log(`\nFund this address (testnet: https://faucet.test.mezo.org/), then re-run with --deploy.`);
  process.exit(0);
}
if (bal === 0n) {
  console.error("\n❌ Deployer has no balance — fund it first.");
  process.exit(1);
}

const chain = chainFor(env.network);
console.log(`\nDeploying SessionKeyDelegate…`);
// SECURITY: deploy via viem from the compiled artifact bytecode. The key stays
// inside this Node process — it is never placed on a command line (visible in
// `ps`/`/proc`) and never needs a TTY. forge only compiles; it never sees the key.
execFileSync("forge", ["build"], {
  cwd: "contracts", stdio: "ignore",
  env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
});
const artifactPath = join(process.cwd(), "contracts", "out", "SessionKeyDelegate.sol", "SessionKeyDelegate.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;
const abi = artifact.abi;

const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
const hash = await wallet.deployContract({ abi, bytecode, args: [] });
console.log(`tx        : ${hash}`);
const receipt = await c.waitForTransactionReceipt({ hash });
const addr = receipt.contractAddress!;
console.log(`deployedTo: ${addr}`);

const code = await c.getCode({ address: addr });
console.log(`code      : ${code ? (code.length - 2) / 2 : 0} bytes on-chain ${code && code !== "0x" ? "✅" : "❌"}`);
console.log(`\nSet in env / Railway:\n  DELEGATE7702_ADDRESS=${addr}`);
