import type { Hex } from "viem";

/**
 * KeyStore — the ONLY component that ever touches raw private-key material.
 *
 * ARCHITECTURE INVARIANT (automatic blocker if violated):
 *   - private keys are NEVER stored in plaintext,
 *   - NEVER written to a log,
 *   - NEVER sent to an LLM provider.
 *
 * This interface is intentionally narrow so the Phase 1 file-backed / app-level
 * encrypted implementation can be swapped for a KMS / HSM / MPC signer with no
 * change to callers. Note there is no `exportPlaintext` in the interface — the
 * signer asks the keystore to *use* a key, it does not extract it.
 */
export type EncryptedKey = {
  /** AES-256-GCM ciphertext (hex). */
  ciphertext: string;
  /** Initialization vector (hex). */
  iv: string;
  /** GCM auth tag (hex). */
  tag: string;
  /** Encryption scheme identifier, for forward migration to KMS. */
  scheme: "aes-256-gcm";
};

export interface KeyStore {
  /** Encrypt a freshly generated / imported private key for at-rest storage. */
  seal(privateKey: Hex): Promise<EncryptedKey>;
  /**
   * Decrypt in-memory ONLY for the duration of `use`, then zero it. The plaintext
   * key must never escape this callback. Callers receive the callback's result,
   * never the key.
   */
  use<T>(sealed: EncryptedKey, fn: (privateKey: Hex) => Promise<T>): Promise<T>;
}
