// Smoke test: exercises the deterministic Phase-1 core end-to-end (no Telegram).

import "./_testenv.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LocalKeyStore } from "../src/custody/localKeystore.js";
import { createWallet, getUser } from "../src/wallet/walletService.js";
import { getPortfolio, prettyAmount } from "../src/portfolio/portfolioService.js";
import { fallbackParse } from "../src/llm/adapter.js";
import { registry } from "../src/registry/registry.js";

async function main() {
  // 1. Custody: seal/use round-trip must return the original key, and never leak it.
  const ks = new LocalKeyStore();
  const pk = generatePrivateKey();
  const addr = privateKeyToAccount(pk).address;
  const sealed = await ks.seal(pk);
  console.log("1. Keystore sealed:", JSON.stringify(sealed).slice(0, 80), "...");
  if (JSON.stringify(sealed).includes(pk.slice(2))) throw new Error("PLAINTEXT LEAK in sealed blob!");
  const recovered = await ks.use(sealed, async (k) => privateKeyToAccount(k).address);
  console.log("   round-trip address match:", recovered === addr);
  if (recovered !== addr) throw new Error("round-trip mismatch");

  // 2. Wallet creation persists an encrypted record.
  const user = await createWallet(123456);
  console.log("2. Wallet created:", user.address, "| type:", user.accountType);
  const reloaded = getUser(123456)!;
  console.log("   stored record has no plaintext privateKey field:", !("privateKey" in reloaded));

  // 3. Live testnet portfolio read.
  console.log("3. Reading portfolio from Mezo testnet RPC...");
  const holdings = await getPortfolio(user.address);
  for (const h of holdings) console.log(`   ${h.token.symbol}: ${prettyAmount(h.formatted)}`);

  // 4. Deterministic intent parsing (LLM disabled).
  const symbols = registry.knownTokenSymbols();
  console.log("4. Fallback parse 'swap 100 MUSD to mUSDC':", JSON.stringify(fallbackParse("swap 100 MUSD to mUSDC", symbols)));
  console.log("   Fallback parse 'hello there':", JSON.stringify(fallbackParse("hello there", symbols)));

  console.log("\nALL SMOKE CHECKS PASSED");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
