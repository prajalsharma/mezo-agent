import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { bytesToHex, isHex, type Hex } from "viem";
import { LocalKeyStore } from "../custody/localKeystore.js";
import { store, type UserRecord } from "../db/store.js";
import { log, errMsg } from "../core/log.js";
import { DEFAULT_LIMITS } from "../custody/policy.js";

/**
 * WalletService — onboarding. Creates or imports an account and hands the raw
 * key straight to the KeyStore for sealing. The plaintext key/seed exists only
 * inside these functions and is never returned, logged, or persisted in clear.
 */
// Lazy so a misconfigured MASTER_ENCRYPTION_KEY is reported by preflight/diag
// rather than crashing at module import with an opaque stack trace.
let _keystore: LocalKeyStore | undefined;
function keystore(): LocalKeyStore {
  return (_keystore ??= new LocalKeyStore());
}

const VALID_MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

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
      limits: DEFAULT_LIMITS,
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

export class WalletImportError extends Error {}
/** @deprecated kept for compatibility; use WalletImportError. */
export class InvalidPrivateKeyError extends WalletImportError {}

/**
 * Import an existing account from either a raw private key (0x + 64 hex) OR a
 * BIP-39 seed phrase (12–24 words). This is the explicitly opt-in, warned path
 * (never the default). The secret is converted to a private key, sealed
 * immediately, and the plaintext is discarded.
 */
export async function importWallet(
  telegramId: number,
  secret: string,
): Promise<UserRecord> {
  const { privateKey, source } = deriveFromSecret(secret);

  let address;
  try {
    address = privateKeyToAccount(privateKey).address;
  } catch {
    throw new WalletImportError("Could not derive an account from that secret.");
  }

  log.step("wallet:import", "seal", { user: telegramId, source, address });
  const sealedKey = await keystore().seal(privateKey);
  const user: UserRecord = {
    telegramId,
    address,
    accountType: "contained-custodial",
    sealedKey,
    mode: "active",
    limits: DEFAULT_LIMITS,
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  return user;
}

/** Detect and derive a private key from a hex key or a BIP-39 mnemonic. */
function deriveFromSecret(secret: string): { privateKey: Hex; source: "key" | "seed" } {
  const trimmed = secret.trim();

  // Private key: optional 0x prefix + 64 hex chars.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const normalized = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
    if (!isHex(normalized) || normalized.length !== 66) {
      throw new WalletImportError("That does not look like a 32-byte private key.");
    }
    return { privateKey: normalized, source: "key" };
  }

  // Seed phrase: 12–24 space-separated words.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (VALID_MNEMONIC_LENGTHS.has(words.length)) {
    const mnemonic = words.join(" ");
    let hdKey;
    try {
      // Default derivation path m/44'/60'/0'/0/0 (standard EVM account 0).
      hdKey = mnemonicToAccount(mnemonic).getHdKey();
    } catch {
      throw new WalletImportError("That seed phrase is invalid (bad word or checksum).");
    }
    if (!hdKey.privateKey) {
      throw new WalletImportError("Could not derive a key from that seed phrase.");
    }
    return { privateKey: bytesToHex(hdKey.privateKey), source: "seed" };
  }

  throw new WalletImportError(
    "That is neither a private key (0x + 64 hex) nor a seed phrase (12–24 words).",
  );
}

export function getUser(telegramId: number): UserRecord | undefined {
  return store.getUser(telegramId);
}

/** Multi-account: create an ADDITIONAL account and make it active. */
export async function createAccount(telegramId: number): Promise<UserRecord> {
  return createWallet(telegramId); // saveUser appends a new address + activates it
}

export function listAccounts(telegramId: number): UserRecord[] {
  return store.listAccounts(telegramId);
}

export function activeIndex(telegramId: number): number {
  return store.activeIndex(telegramId);
}

export function switchAccount(telegramId: number, index: number): UserRecord | undefined {
  return store.switchAccount(telegramId, index);
}

/** Set watch-only vs active mode. Watch-only blocks all signing. */
export function setMode(telegramId: number, mode: "active" | "watch-only"): UserRecord | undefined {
  const user = store.getUser(telegramId);
  if (!user) return undefined;
  user.mode = mode;
  store.saveUser(user);
  return user;
}
