import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Address } from "viem";
import { env } from "../config/env.js";
import type { EncryptedKey } from "../custody/keystore.js";
import type { SpendingLimits } from "../custody/policy.js";

/**
 * Phase 1 datastore. Production target is Postgres + Redis (architecture §9);
 * this file-backed implementation keeps the same shape behind a small interface
 * so the swap is mechanical. It stores ONLY encrypted key material and public
 * data — never a plaintext key.
 */

export type AccountType = "contained-custodial" | "smart-account" | "eip7702-delegated";

/**
 * A scoped EIP-7702 session key (Option A: semi-custodial). Its own sealed key
 * material and address. Day-to-day ops are signed by this key and executed via
 * the delegate `execute`, so the root key stays cold except for setup/rotation.
 */
export type SessionKey = {
  address: Address;
  sealedKey: EncryptedKey;
  /** unix seconds; the on-chain session shares this expiry. */
  expiresAt: number;
};

/** On-chain delegation state once the account has been upgraded via a type-0x04 tx. */
export type Delegation = {
  /** The SessionKeyDelegate address the root EOA points at. */
  target: Address;
  installedAt: string;
  /** Tx hash of the set-code transaction that installed the delegation. */
  txHash?: string;
};

export type UserRecord = {
  telegramId: number;
  address: Address;
  accountType: AccountType;
  /** Sealed (AES-GCM) key material. Never a plaintext key. */
  sealedKey: EncryptedKey;
  mode: "active" | "watch-only";
  /** Per-user spending caps. Undefined ⇒ DEFAULT_LIMITS applied at read. */
  limits?: SpendingLimits;
  /** Present once the account is upgraded to an EIP-7702 smart account. */
  session?: SessionKey;
  delegation?: Delegation;
  createdAt: string;
};

export type TxRecord = {
  telegramId: number;
  kind: string; // e.g. "swap"
  summary: string;
  hash?: string;
  status: "submitted" | "confirmed" | "failed";
  at: string;
};

/** Ledger of native value reserved/submitted — backs the daily cap. */
export type SpendRecord = {
  id: string;
  telegramId: number;
  valueWei: string;
  at: string; // ISO timestamp
};

type Db = {
  users: Record<string, UserRecord>;
  txHistory: TxRecord[];
  spendLedger: SpendRecord[];
};

class Store {
  private db: Db = { users: {}, txHistory: [], spendLedger: [] };
  private readonly path: string;

  constructor() {
    try {
      mkdirSync(env.dataDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `DATA_DIR "${env.dataDir}" is not creatable/writable. On serverless or ` +
          `read-only hosts (e.g. Vercel), point DATA_DIR at a writable path or ` +
          `move to Postgres. Cause: ${(err as Error).message}`,
      );
    }
    this.path = join(env.dataDir, `mezo-agent.${env.network}.json`);
    if (existsSync(this.path)) {
      const loaded = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Db>;
      // Backfill fields added in later versions so old stores load cleanly.
      this.db = {
        users: loaded.users ?? {},
        txHistory: loaded.txHistory ?? [],
        spendLedger: loaded.spendLedger ?? [],
      };
    } else {
      this.flush();
    }
  }

  private flush(): void {
    try {
      // Written with 0600-equivalent intent; on POSIX the file inherits umask.
      writeFileSync(this.path, JSON.stringify(this.db, null, 2), { mode: 0o600 });
    } catch (err) {
      throw new Error(
        `Failed to persist wallet data to ${this.path}. The filesystem may be ` +
          `read-only. Set DATA_DIR to a writable path or use Postgres. ` +
          `Cause: ${(err as Error).message}`,
      );
    }
  }

  getUser(telegramId: number): UserRecord | undefined {
    return this.db.users[String(telegramId)];
  }

  saveUser(user: UserRecord): void {
    this.db.users[String(user.telegramId)] = user;
    this.flush();
  }

  addTx(tx: TxRecord): void {
    this.db.txHistory.push(tx);
    this.flush();
  }

  updateTxByHash(hash: string, status: TxRecord["status"]): void {
    const rec = [...this.db.txHistory].reverse().find((t) => t.hash === hash);
    if (rec) {
      rec.status = status;
      this.flush();
    }
  }

  recentTx(telegramId: number, limit = 5): TxRecord[] {
    return this.db.txHistory
      .filter((t) => t.telegramId === telegramId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Reserve native value against the rolling daily cap and return a handle.
   * Reserving BEFORE submit (rather than recording after) closes the TOCTOU
   * window where two rapid actions could both pass the cap check. Release the
   * handle with `releaseSpend` if the submission fails.
   */
  addSpend(telegramId: number, valueWei: bigint, at: string): string {
    const id = randomUUID();
    if (valueWei <= 0n) return id;
    this.db.spendLedger.push({ id, telegramId, valueWei: valueWei.toString(), at });
    this.flush();
    return id;
  }

  /** Undo a reservation (e.g. the submit threw), so it doesn't count against the cap. */
  releaseSpend(id: string): void {
    const before = this.db.spendLedger.length;
    this.db.spendLedger = this.db.spendLedger.filter((s) => s.id !== id);
    if (this.db.spendLedger.length !== before) this.flush();
  }

  /** Sum of native value spent by a user within the last 24h. */
  spentLast24hWei(telegramId: number, now = Date.now()): bigint {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return this.db.spendLedger
      .filter((s) => s.telegramId === telegramId && Date.parse(s.at) >= cutoff)
      .reduce((sum, s) => sum + BigInt(s.valueWei), 0n);
  }
}

export const store = new Store();
