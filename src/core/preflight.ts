import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { chainFor } from "../chain/networks.js";
import { publicClient } from "../chain/client.js";
import { LocalKeyStore } from "../custody/localKeystore.js";
import { store } from "../db/store.js";
import { probe7702Support } from "../chain/eip7702.js";
import { registry } from "../registry/registry.js";
import { errMsg } from "./log.js";

/**
 * Preflight self-checks — the diagnostic backbone.
 *
 * Each check exercises one real subsystem in the wallet-creation path and
 * reports ✅/❌ with the exact failure. Run at startup (console) and on demand
 * via /diag (in-chat), so "wallet creation doesn't work" is immediately
 * localized to config / keystore / datastore / RPC instead of guessed at.
 */
export type CheckResult = { name: string; ok: boolean; detail: string };

async function check(name: string, fn: () => Promise<string> | string): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: errMsg(err) };
  }
}

export async function runPreflight(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Config — the two required secrets and their shape.
  results.push(
    await check("config", () => {
      if (!env.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is empty");
      const hex = env.masterEncryptionKey.replace(/^0x/, "");
      if (hex.length !== 64) throw new Error(`MASTER_ENCRYPTION_KEY must be 64 hex chars, got ${hex.length}`);
      return `network=${env.network}, token set, master key 32 bytes`;
    }),
  );

  // 2. Keystore — a full encrypt→decrypt round-trip must recover the key.
  results.push(
    await check("keystore", async () => {
      const ks = new LocalKeyStore();
      const pk = generatePrivateKey();
      const addr = privateKeyToAccount(pk).address;
      const sealed = await ks.seal(pk);
      if (JSON.stringify(sealed).includes(pk.slice(2))) throw new Error("plaintext leaked into sealed blob");
      const back = await ks.use(sealed, async (k) => privateKeyToAccount(k).address);
      if (back !== addr) throw new Error("round-trip address mismatch");
      return "AES-256-GCM seal/use round-trip OK";
    }),
  );

  // 3. Datastore — a real write+read probe against the configured DATA_DIR.
  results.push(
    await check("datastore", () => {
      const probeId = -999_000_001; // reserved probe id; overwritten each run
      store.saveUser({
        telegramId: probeId,
        address: "0x0000000000000000000000000000000000000000",
        accountType: "contained-custodial",
        sealedKey: { ciphertext: "00", iv: "00", tag: "00", scheme: "aes-256-gcm" },
        mode: "watch-only",
        createdAt: new Date().toISOString(),
      });
      const got = store.getUser(probeId);
      if (!got) throw new Error("wrote probe record but could not read it back");
      // PERSISTENCE WARNING: a relative DATA_DIR (e.g. ./data) is almost always
      // ephemeral in a container — every redeploy wipes user wallets. On
      // Railway/Fly this MUST be an absolute path backed by a mounted volume.
      const ephemeral = !env.dataDir.startsWith("/");
      const note = ephemeral
        ? ` ⚠️ EPHEMERAL PATH — attach a persistent volume and set DATA_DIR to it (e.g. /data), or user wallets are LOST on every redeploy.`
        : "";
      return `writable at DATA_DIR=${env.dataDir}${note}`;
    }),
  );

  // 4. RPC — reachable, and the chain id matches the configured network.
  results.push(
    await check("rpc", async () => {
      const expected = chainFor(env.network).id;
      const actual = await publicClient().getChainId();
      if (actual !== expected) throw new Error(`RPC chainId ${actual} != expected ${expected}`);
      const block = await publicClient().getBlockNumber();
      return `${chainFor(env.network).rpcUrls.default.http[0]} chainId=${actual} block=${block}`;
    }),
  );

  // 5. EIP-7702 — non-fatal. Confirms the endpoint accepts set-code (type-0x04)
  //    transactions and reports whether the session-key delegate is configured.
  //    This is the "week-one capability probe" that gates the non-custodial path.
  results.push(
    await check("eip7702", async () => {
      const probe = await probe7702Support();
      const delegate = registry.hasContract("Delegate7702")
        ? `delegate=${registry.contract("Delegate7702")}`
        : "delegate=unset (session-key contract not yet deployed/registered)";
      if (!probe.supported) throw new Error(`${probe.detail}; ${delegate}`);
      return `${probe.detail}; ${delegate}`;
    }),
  );

  return results;
}

export function formatPreflightText(results: CheckResult[]): string {
  return results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`).join("\n");
}
