import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { env } from "../config/env.js";
import type { EncryptedKey, KeyStore } from "./keystore.js";

/**
 * LocalKeyStore — Tier 3 "contained custodial" stopgap (see README trust model).
 *
 * AES-256-GCM envelope encryption using MASTER_ENCRYPTION_KEY. This is the
 * app-level-encryption fallback for local Phase 1 development. The production
 * design replaces this class with a KMS/HSM/MPC-backed KeyStore — same interface,
 * so nothing else changes. Application-level encryption alone is NOT acceptable
 * for mainnet custody; that is documented explicitly.
 */
export class LocalKeyStore implements KeyStore {
  private readonly masterKey: Buffer;

  constructor() {
    const hex = env.masterEncryptionKey.replace(/^0x/, "");
    if (hex.length !== 64) {
      throw new Error(
        "MASTER_ENCRYPTION_KEY must be 32 bytes (64 hex chars). Run `npm run genkey`.",
      );
    }
    this.masterKey = Buffer.from(hex, "hex");
  }

  async seal(privateKey: Hex): Promise<EncryptedKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const pk = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
    const ciphertext = Buffer.concat([cipher.update(pk), cipher.final()]);
    const tag = cipher.getAuthTag();
    // pk is a local Buffer; overwrite before it leaves scope.
    pk.fill(0);
    return {
      ciphertext: ciphertext.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      scheme: "aes-256-gcm",
    };
  }

  async use<T>(sealed: EncryptedKey, fn: (privateKey: Hex) => Promise<T>): Promise<T> {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      Buffer.from(sealed.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    const pk = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "hex")),
      decipher.final(),
    ]);
    const hex = `0x${pk.toString("hex")}` as Hex;
    try {
      return await fn(hex);
    } finally {
      // Best-effort scrubbing of the decrypted material.
      pk.fill(0);
    }
  }
}
