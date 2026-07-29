/**
 * Live swap-quote check against Mezo MAINNET pools. Read-only: proves the quote
 * path reads real reserves and computes min-out, with execution correctly gated
 * (no Router in the registry). No key, no writes.
 *
 *   MEZO_NETWORK=mainnet MASTER_ENCRYPTION_KEY=$(npm run -s genkey) \
 *   TELEGRAM_BOT_TOKEN=x npx tsx scripts/swapcheck.ts
 */
import "./_testenv.js";
import { registry } from "../src/registry/registry.js";
import { env } from "../src/config/env.js";
import { buildSwap, SwapUnavailableError } from "../src/surfaces/swap/swapBuilder.js";

const OWNER = "0x0000000000000000000000000000000000000001" as const;

async function quote(from: string, to: string, amount: string) {
  const tokenIn = registry.token(from);
  const tokenOut = registry.token(to);
  try {
    const p = await buildSwap({ owner: OWNER, tokenIn, tokenOut, humanAmountIn: amount, slippagePct: 0.5 });
    console.log(
      `  ${amount} ${from} → ${p.expectedOutFormatted} ${to} ` +
        `(min ${p.minOutFormatted}, ${p.stable ? "stable" : "volatile"} pool, ` +
        `executable=${p.executable}${p.executable ? "" : " — gated"})`,
    );
    if (Number(p.expectedOutFormatted) <= 0) throw new Error("zero quote");
  } catch (e) {
    if (e instanceof SwapUnavailableError) console.log(`  ${from}→${to}: ${e.message}`);
    else throw e;
  }
}

async function main() {
  console.log(`Swap quote check — ${env.network.toUpperCase()}`);
  console.log("Tokens:", registry.knownTokenSymbols().join(", "));
  console.log("Pools:", registry.pools().map((p) => p.pair.join("/")).join(", ") || "(none)");
  console.log("Router present:", registry.hasContract("Router"), "\n--- live quotes ---");

  await quote("MUSD", "mUSDC", "100");
  await quote("BTC", "MUSD", "0.01");
  await quote("MUSD", "mUSDT", "250");

  console.log("\n✅ Quote path exercised against live pools.");
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
