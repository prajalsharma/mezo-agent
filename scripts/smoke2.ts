// Verifies the new onboarding/custody features: seed-phrase import + spend caps.
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { parseEther } from "viem";
import { importWallet, getUser } from "../src/wallet/walletService.js";
import { signAndSubmit, PolicyViolationError } from "../src/custody/signer.js";
import { store } from "../src/db/store.js";

// A well-known BIP-39 test vector (NEVER use for real funds).
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

async function main() {
  // 1. Seed-phrase import derives the canonical EVM account (m/44'/60'/0'/0/0).
  const expected = mnemonicToAccount(TEST_MNEMONIC).address;
  const user = await importWallet(1001, TEST_MNEMONIC);
  console.log("1. seed import → address:", user.address);
  console.log("   matches viem mnemonicToAccount:", user.address === expected);
  if (user.address !== expected) throw new Error("seed-phrase derivation mismatch");
  if (JSON.stringify(getUser(1001)).includes(TEST_MNEMONIC.split(" ")[0] + " test")) {
    throw new Error("mnemonic leaked into stored record");
  }
  console.log("   stored record contains no plaintext seed:", true);

  // 2. Private-key import still works.
  const pk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // test key
  const u2 = await importWallet(1002, pk);
  console.log("2. key import → address:", u2.address, "matches:", u2.address === privateKeyToAccount(pk).address);

  // 3. Per-tx cap: a native value above the per-tx limit must be REFUSED by the signer.
  const overCap = parseEther("1"); // default per-tx cap is 0.05 BTC
  let blocked = false;
  try {
    await signAndSubmit(getUser(1001)!, {
      to: "0x000000000000000000000000000000000000dEaD",
      value: overCap,
      policy: { allowedTargets: ["0x000000000000000000000000000000000000dEaD"] },
    });
  } catch (e) {
    blocked = e instanceof PolicyViolationError;
    console.log("3. per-tx cap blocked over-limit tx:", blocked, "→", (e as Error).message.slice(0, 60));
  }
  if (!blocked) throw new Error("per-tx cap did NOT block an over-limit tx");

  // 4. Watch-only blocks signing entirely.
  const w = getUser(1002)!;
  w.mode = "watch-only";
  store.saveUser(w);
  let watchBlocked = false;
  try {
    await signAndSubmit(getUser(1002)!, {
      to: "0x000000000000000000000000000000000000dEaD",
      value: 0n,
      policy: { allowedTargets: ["0x000000000000000000000000000000000000dEaD"] },
    });
  } catch (e) {
    watchBlocked = e instanceof PolicyViolationError;
  }
  console.log("4. watch-only blocks signing:", watchBlocked);
  if (!watchBlocked) throw new Error("watch-only did NOT block signing");

  console.log("\nALL CUSTODY/ONBOARDING CHECKS PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
