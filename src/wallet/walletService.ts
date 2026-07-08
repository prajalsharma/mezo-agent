import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isHex, type Hex } from "viem";
import { LocalKeyStore } from "../custody/localKeystore.js";
import { store, type UserRecord } from "../db/store.js";
import { log, errMsg } from "../core/log.js";

/**
 * WalletService — onboarding. Creates or imports an account and hands the raw
 * key straight to the KeyStore for sealing. The plaintext key exists only inside
 * these functions and is never returned, logged, or persisted in the clear.
 */
// Lazy so a misconfigured MASTER_ENCRYPTION_KEY is reported by preflight/diag
// rather than crashing at module import with an opaque stack trace.
let _keystore: LocalKeyStore | undefined;
function keystore(): LocalKeyStore {
  return (_keystore ??= new LocalKeyStore());
}

export async function createWallet(telegramId: number): Promise<UserRecord> {
  const flow = "wallet:create";
  try {
    log.step(flow, "generate-key", { user: telegramId });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    log.step(flow, "seal", { user: telegramId, address: account.address });
    const sealedKey = await keystore().seal(pk);

    const user: UserRecord = {
      telegramId,
      address: account.address,
      accountType: "contained-custodial",
      sealedKey,
      mode: "active",
      createdAt: new Date().toISOString(),
    };

    log.step(flow, "persist", { user: telegramId, address: account.address });
    store.saveUser(user);

    log.step(flow, "done", { user: telegramId, address: account.address });
    return user;
  } catch (err) {
    // Re-throw with a step-tagged message so the handler/error-boundary shows
    // exactly where it broke.
    log.error(`${flow}.failed`, { user: telegramId, error: errMsg(err) });
    throw new Error(`Wallet creation failed: ${errMsg(err)}`);
  }
}

export class InvalidPrivateKeyError extends Error {}

/**
 * Import an existing account from a raw private key. This is the explicitly
 * opt-in, warned path (never the default). The key is sealed immediately and
 * the plaintext is discarded.
 */
export async function importWallet(
  telegramId: number,
  rawKey: string,
): Promise<UserRecord> {
  const normalized = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!isHex(normalized) || normalized.length !== 66) {
    throw new InvalidPrivateKeyError("That does not look like a 32-byte private key.");
  }
  let account;
  try {
    account = privateKeyToAccount(normalized);
  } catch {
    throw new InvalidPrivateKeyError("Could not derive an account from that key.");
  }
  const sealedKey = await keystore().seal(normalized);
  const user: UserRecord = {
    telegramId,
    address: account.address,
    accountType: "contained-custodial",
    sealedKey,
    mode: "active",
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  return user;
}

export function getUser(telegramId: number): UserRecord | undefined {
  return store.getUser(telegramId);
}
