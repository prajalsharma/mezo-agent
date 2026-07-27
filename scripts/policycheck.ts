/**
 * Signer policy checks — the "compromised session cannot drain an account"
 * guarantees. Exercises only the BLOCKING paths (which throw before any network
 * call) plus the reserve/release ledger semantics. No RPC, no submitted tx.
 *
 *   MASTER_ENCRYPTION_KEY=$(npm run -s genkey) TELEGRAM_BOT_TOKEN=x \
 *   DATA_DIR=$(mktemp -d) npx tsx scripts/policycheck.ts
 */
import { parseEther, parseUnits, type Address } from "viem";
import { createWallet, setMode } from "../src/wallet/walletService.js";
import { signAndSubmit, PolicyViolationError } from "../src/custody/signer.js";
import { store } from "../src/db/store.js";

const TARGET = "0x000000000000000000000000000000000000BEEF" as Address;

function ok(name: string) { console.log("  ✓ " + name); }
async function expectBlock(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error(`FAIL: ${name} — expected a PolicyViolationError, none thrown`);
  } catch (e) {
    if (e instanceof PolicyViolationError) return ok(name + " → blocked: " + e.message.slice(0, 60));
    throw e;
  }
}

async function main() {
  console.log("Signer policy checks\n" + "=".repeat(50));
  const user = await createWallet(1234567);

  // 1. Per-tx native cap (default 0.05 BTC): 1 BTC is blocked before any network call.
  await expectBlock("per-tx native cap", () =>
    signAndSubmit(user, { to: TARGET, value: parseEther("1"), policy: { allowedTargets: [TARGET] } }),
  );

  // 2. Allowlist: a target the app didn't intend is rejected.
  await expectBlock("target allowlist", () =>
    signAndSubmit(user, { to: TARGET, value: parseEther("0.001"), policy: { allowedTargets: ["0x0000000000000000000000000000000000000001"] } }),
  );

  // 3. Daily rolling cap (default 0.2 BTC): pre-seed near the cap, then a small tx tips over.
  store.addSpend(user.telegramId, parseEther("0.19"), new Date().toISOString());
  await expectBlock("daily rolling cap", () =>
    signAndSubmit(user, { to: TARGET, value: parseEther("0.04"), policy: { allowedTargets: [TARGET] } }),
  );

  // 4. Watch-only mode blocks all signing.
  const watched = setMode(user.telegramId, "watch-only")!;
  await expectBlock("watch-only blocks signing", () =>
    signAndSubmit(watched, { to: TARGET, value: 0n, policy: { allowedTargets: [TARGET] } }),
  );
  setMode(user.telegramId, "active");

  // 5. Per-token ERC-20 cap (opt-in): over-cap token amount is blocked.
  const capped = setMode(user.telegramId, "active")!;
  capped.limits = { ...capped.limits!, perTxTokenCaps: { MUSD: parseUnits("100", 18).toString() } } as never;
  store.saveUser(capped);
  await expectBlock("per-token ERC-20 cap", () =>
    signAndSubmit(store.getUser(user.telegramId)!, {
      to: TARGET, value: 0n,
      policy: { allowedTargets: [TARGET], erc20: { symbol: "MUSD", amount: parseUnits("200", 18) } },
    }),
  );

  // 6. Reserve/release (TOCTOU): a reservation counts immediately; releasing undoes it.
  const before = store.spentLast24hWei(user.telegramId);
  const id = store.addSpend(user.telegramId, parseEther("0.01"), new Date().toISOString());
  if (store.spentLast24hWei(user.telegramId) !== before + parseEther("0.01")) throw new Error("FAIL: reservation not counted");
  store.releaseSpend(id);
  if (store.spentLast24hWei(user.telegramId) !== before) throw new Error("FAIL: release did not undo reservation");
  ok("reserve counts immediately; release undoes it (TOCTOU closed)");

  console.log("\nAll policy checks passed. ✅");
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
