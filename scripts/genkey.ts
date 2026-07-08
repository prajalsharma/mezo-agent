import { randomBytes } from "node:crypto";

/**
 * Generate a 32-byte AES-256 master key for MASTER_ENCRYPTION_KEY.
 * This key encrypts user private keys at rest (Phase 1 Tier-3 stopgap).
 * Keep it out of version control; in production it lives in a KMS/HSM.
 */
const key = randomBytes(32).toString("hex");
console.log(key);
