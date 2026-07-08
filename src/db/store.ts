import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { env } from "../config/env.js";
import type { EncryptedKey } from "../custody/keystore.js";

/**
 * Phase 1 datastore. Production target is Postgres + Redis (architecture §9);
 * this file-backed implementation keeps the same shape behind a small interface
 * so the swap is mechanical. It stores ONLY encrypted key material and public
 * data — never a plaintext key.
 */

export type AccountType = "contained-custodial" | "smart-account" | "eip7702-delegated";

export type UserRecord = {
  telegramId: number;
  address: Address;
  accountType: AccountType;
  /** Sealed (AES-GCM) key material. Never a plaintext key. */
  sealedKey: EncryptedKey;
  mode: "active" | "watch-only";
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

type Db = {
  users: Record<string, UserRecord>;
  txHistory: TxRecord[];
};

class Store {
  private db: Db = { users: {}, txHistory: [] };
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
      this.db = JSON.parse(readFileSync(this.path, "utf8")) as Db;
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
}

export const store = new Store();
