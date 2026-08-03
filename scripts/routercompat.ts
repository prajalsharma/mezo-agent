export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Does the code the bot emits actually exist on the DEPLOYED FeeRouter?
 *
 * This class of bug has bitten twice: the source gains a function, a call site
 * is pointed at it, and the live router - which nobody redeployed - reverts with
 * no useful reason AFTER the user's approval has been mined. It is invisible to
 * every offline check, because offline checks never look at bytecode.
 *
 * Run before deploying the bot, and after any FeeRouter redeploy:
 *   MEZO_NETWORK=testnet FEE_ROUTER_ADDRESS=0x… npx tsx scripts/routercompat.ts
 */
import { toFunctionSelector, type Address } from "viem";
import { publicClient } from "../src/chain/client.js";
import { env } from "../src/config/env.js";
import { registry } from "../src/registry/registry.js";
import { buildZap } from "../src/surfaces/zap.js";
import { buildSwap } from "../src/surfaces/swap/swapBuilder.js";

const addr = (process.env.FEE_ROUTER_ADDRESS ??
  (registry.hasContract("FeeRouter") ? registry.contract("FeeRouter") : "")) as Address;
if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
  console.log("No FeeRouter configured - atomic fees are off, nothing to check.");
  process.exit(0);
}

const code = await publicClient().getCode({ address: addr });
if (!code || code === "0x") {
  console.error(`No contract at ${addr} on ${env.network}.`);
  process.exit(1);
}

const owner = "0x2B325c6768a11B2E7Cc9cF3EF8513A426677Bde9" as Address;
let fail = 0;
const ok = (n: string, c: boolean) => {
  console.log(`  ${c ? "✓" : "✗ FAIL"} ${n}`);
  if (!c) fail++;
};

/** Every selector the bot would send to the FeeRouter must be in its bytecode. */
function emits(label: string, steps: Array<{ to: Address; data?: `0x${string}` }>) {
  for (const s of steps) {
    if (s.to.toLowerCase() !== addr.toLowerCase() || !s.data) continue;
    const sel = s.data.slice(2, 10);
    ok(`${label}: selector 0x${sel} exists on the deployed router`, code!.includes(sel));
  }
}

console.log(`FeeRouter ${addr} on ${env.network}\n`);

const btc = registry.token("BTC");
const musd = registry.token("MUSD");

try {
  const swap: any = await buildSwap({
    owner, tokenIn: musd, tokenOut: registry.token("mUSDC"), humanAmountIn: "100", slippagePct: 0.5,
  });
  emits("swap", swap.steps ?? []);
} catch (e) {
  console.log(`  (swap plan unavailable: ${(e as Error).message.slice(0, 70)})`);
}

try {
  const zap: any = await buildZap(
    { action: "zap", inputToken: btc.symbol, inputAmount: "0.001", pool: `${btc.symbol}/${musd.symbol}`, stake: false } as any,
    owner,
  );
  emits("zap", zap.steps ?? []);
} catch (e) {
  console.log(`  (zap plan unavailable: ${(e as Error).message.slice(0, 70)})`);
}

console.log(fail === 0 ? "\nRouter compatibility OK. ✅" : `\n${fail} INCOMPATIBLE CALL(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
