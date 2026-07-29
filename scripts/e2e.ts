/**
 * LIVE end-to-end test on Matsnet testnet. Funds a fresh bot wallet from the
 * deployer and drives REAL signed transactions through the actual pipeline
 * (buildActionPlan → simulate → sign-within-policy → submit), then reports tx
 * hashes. This is the on-chain proof that the Telegram → sign → chain loop works.
 *
 *   MEZO_NETWORK=testnet npx tsx scripts/e2e.ts
 *
 * Requires ~/.mezo-agent-deploy/deployer.key funded with testnet BTC.
 */
import "./_testenv.js";
process.env.DATA_DIR = "./data-e2e";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, parseEther, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { createWallet } from "../src/wallet/walletService.js";
import { store } from "../src/db/store.js";
import { buildActionPlan } from "../src/surfaces/dispatch.js";
import { executeActionPlan } from "../src/surfaces/plan.js";
import { buildSwap } from "../src/surfaces/swap/swapBuilder.js";
import { executeSwap } from "../src/surfaces/swap/swapService.js";
import { registry } from "../src/registry/registry.js";

const chain = chainFor("testnet");
const c = publicClient();
const explorer = (h: string) => `https://explorer.test.mezo.org/tx/${h}`;
const results: string[] = [];
const log = (m: string) => { console.log(m); };

async function fund(to: Hex, amount: bigint) {
  const pk = readFileSync(join(homedir(), ".mezo-agent-deploy", "deployer.key"), "utf8").trim() as Hex;
  const account = privateKeyToAccount(pk);
  const bal = await c.getBalance({ address: account.address });
  log(`Deployer ${account.address}: ${formatEther(bal)} BTC`);
  if (bal < amount) throw new Error(`deployer has ${formatEther(bal)} BTC, need ${formatEther(amount)}`);
  const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
  const hash = await wallet.sendTransaction({ to, value: amount } as never);
  await c.waitForTransactionReceipt({ hash });
  log(`Funded bot wallet with ${formatEther(amount)} BTC → ${explorer(hash)}`);
}

async function runAction(label: string, intent: unknown, owner: Hex) {
  log(`\n▶ ${label}`);
  const plan = await buildActionPlan(intent as never, owner);
  if (!plan) { log(`  ✗ no plan`); results.push(`${label}: ✗ no plan`); return; }
  if (!plan.executable) { log(`  🔒 gated: ${plan.gatedReason}`); results.push(`${label}: 🔒 ${plan.gatedReason}`); return; }
  const user = store.getUser(999001)!;
  const exec = await executeActionPlan(user, plan, async (m) => log(`  · ${m}`));
  const last = exec.outcomes[exec.outcomes.length - 1];
  if (exec.aborted || !last?.ok) {
    log(`  ✗ ${last && !last.ok ? last.reason : "aborted"}`);
    results.push(`${label}: ✗ ${last && !last.ok ? last.reason : "aborted"}`);
  } else {
    for (const o of exec.outcomes) if (o.ok) log(`  ✓ ${o.kind}: ${explorer(o.hash)}`);
    results.push(`${label}: ✅ ${exec.outcomes.filter((o) => o.ok).map((o) => o.hash).join(", ")}`);
  }
}

async function main() {
  log(`Network: testnet (${chain.id})\nBTC price: (sized against ~$64k)\n`);

  const user = await createWallet(999001);
  const owner = user.address as Hex;
  log(`Bot wallet: ${owner}`);

  await fund(owner, parseEther("0.048"));
  const bal = await c.getBalance({ address: owner });
  log(`Bot wallet balance: ${formatEther(bal)} BTC`);

  // 1. BORROW — open a Trove: 0.035 BTC collateral → 1800 MUSD (~125% ratio).
  await runAction("Borrow 1800 MUSD against 0.035 BTC", { action: "borrow", mintMUSD: "1800", collateralBTC: "0.035" }, owner);

  // 2. LOCK veBTC — 0.005 BTC for 28 days.
  await runAction("Lock 0.005 BTC for 28 days (veBTC)", { action: "lock", asset: "BTC", amount: "0.005", lockDays: 28 }, owner);

  // 3. SWAP — 100 MUSD → mUSDC (needs the MUSD minted in step 1).
  log(`\n▶ Swap 100 MUSD → mUSDC`);
  try {
    const tin = registry.token("MUSD"), tout = registry.token("mUSDC");
    const plan = await buildSwap({ owner, tokenIn: tin, tokenOut: tout, humanAmountIn: "100", slippagePct: 0.5 });
    if (!plan.executable) { log(`  🔒 ${plan.gatedReason}`); results.push(`Swap: 🔒 ${plan.gatedReason}`); }
    else {
      const exec = await executeSwap(store.getUser(999001)!, plan, async (m) => log(`  · ${m}`));
      const last = exec.outcomes[exec.outcomes.length - 1];
      if (exec.aborted || !last?.ok) { log(`  ✗ ${last && !last.ok ? last.reason : "aborted"}`); results.push(`Swap: ✗ ${last && !last.ok ? last.reason : "aborted"}`); }
      else { for (const o of exec.outcomes) if (o.ok) log(`  ✓ ${o.kind}: ${explorer(o.hash)}`); results.push(`Swap: ✅ ${exec.outcomes.filter((o) => o.ok).map((o) => o.hash).join(", ")}`); }
    }
  } catch (e: unknown) { log(`  ✗ ${e instanceof Error ? e.message : String(e)}`); results.push(`Swap: ✗ ${e instanceof Error ? e.message : String(e)}`); }

  log(`\n════════ E2E RESULTS ════════`);
  results.forEach((r) => log("  " + r));
}

main().catch((e) => { console.error("E2E FAILED:", e); process.exit(1); });
