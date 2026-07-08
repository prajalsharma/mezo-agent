import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isHex, type Hex } from "viem";
import { LocalKeyStore } from "../custody/localKeystore.js";
import { store, type UserRecord } from "../db/store.js";

/**
 * WalletService — onboarding. Creates or imports an account and hands the raw
 * key straight to the KeyStore for sealing. The plaintext key exists only inside
 * these functions and is never returned, logged, or persisted in the clear.
 */
const keystore = new LocalKeyStore();

export async function createWallet(telegramId: number): Promise<UserRecord> {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const sealedKey = await keystore.seal(pk);
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
  const sealedKey = await keystore.seal(normalized);
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
