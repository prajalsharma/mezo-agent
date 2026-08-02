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
  /** Telegram id of the user who referred this one (deep-link attribution). */
  referredBy?: number;
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

/** A pre-authorized, revocable DCA schedule (Phase 5 automation). */
export type DcaSchedule = {
  id: string;
  telegramId: number;
  accountAddress: Address;
  fromToken: string;
  toToken: string;
  amount: string; // human amount per interval
  everyHours: number;
  remaining: number; // occurrences left (Infinity-safe: -1 = unbounded)
  nextRunAt: string; // ISO
  createdAt: string;
  active: boolean;
};

/** Per-account epoch auto-compound preference (Phase 5 automation). */
export type AutoCompound = {
  telegramId: number;
  accountAddress: Address;
  enabled: boolean;
  intoToken?: string;
};

type Db = {
  /** Multi-account: each Telegram user can hold several accounts. */
  accounts: Record<string, UserRecord[]>;
  active: Record<string, number>;
  txHistory: TxRecord[];
  spendLedger: SpendRecord[];
  schedules: DcaSchedule[];
  autoCompound: AutoCompound[];
  /** Emergency stop for ALL scheduled automation (operator-level). */
  keeperPaused?: boolean;
  /** Telegram ids that have paused their own automation. */
  pausedUsers?: number[];
  /** Referral rewards paid to each referrer (split-at-source; history record). */
  referralEarnings?: Record<string, { trades: number; byToken: Record<string, string> }>;
  /** Agent fees whose fee-tx failed after the main action succeeded (uncollected revenue). */
  owedFees?: OwedFee[];
  /** Deep-link referral clicks awaiting wallet creation (persisted so a redeploy
   *  between click and create can't drop the credit). Keyed by new-user id. */
  pendingReferrals?: Record<string, { referrer: number; expiresAt: number }>;
  /** Proactive-alert opt-ins (all OFF by default — the bot never messages first
   *  unless a specific alert type was explicitly enabled). Keyed by telegramId. */
  alertPrefs?: Record<string, AlertPrefs>;
  /** Per-user anti-spam state for alerts (last-sent timestamps / epoch marks). */
  alertState?: Record<string, AlertState>;
};

export type AlertPrefs = { trove: boolean; rewards: boolean; epoch: boolean };
export type AlertState = {
  /** Last trove-health alert: when, and at what ICR band (re-alert only on a
   *  meaningfully worse band or after the cooldown). */
  troveAt?: number;
  troveICR?: number;
  rewardsAt?: number;
  /** Epoch-start timestamp (ms) of the last epoch-close reminder sent. */
  epochMark?: number;
};

export type OwedFee = {
  telegramId: number;
  symbol: string;
  /** Raw base-unit amount as a decimal string. */
  amountRaw: string;
  /** What the fee was for, e.g. "swap MUSD→mUSDC". */
  context: string;
  reason: string;
  at: string;
  /** Who the failed payout was FOR — a failed referrer cut is not operator
   *  revenue and must not inflate the operator's uncollected-fee report. */
  beneficiary?: "operator" | "referrer";
};

type LegacyDb = Db & { users?: Record<string, UserRecord> };

class Store {
  private db: Db = { accounts: {}, active: {}, txHistory: [], spendLedger: [], schedules: [], autoCompound: [] };
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
      const loaded = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LegacyDb>;
      const accounts = loaded.accounts ?? {};
      // Migrate a legacy single-account store ({users}) into the multi-account shape.
      if (loaded.users && Object.keys(accounts).length === 0) {
        for (const [id, user] of Object.entries(loaded.users)) accounts[id] = [user];
      }
      this.db = {
        accounts,
        active: loaded.active ?? {},
        txHistory: loaded.txHistory ?? [],
        spendLedger: loaded.spendLedger ?? [],
        schedules: loaded.schedules ?? [],
        autoCompound: loaded.autoCompound ?? [],
        keeperPaused: loaded.keeperPaused ?? false,
        pausedUsers: loaded.pausedUsers ?? [],
        // These were previously dropped here, wiping them on every restart.
        referralEarnings: loaded.referralEarnings ?? {},
        owedFees: loaded.owedFees ?? [],
        pendingReferrals: loaded.pendingReferrals ?? {},
        alertPrefs: loaded.alertPrefs ?? {},
        alertState: loaded.alertState ?? {},
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

  /** The user's ACTIVE account (multi-account aware). */
  getUser(telegramId: number): UserRecord | undefined {
    const list = this.db.accounts[String(telegramId)];
    if (!list || list.length === 0) return undefined;
    const idx = this.db.active[String(telegramId)] ?? 0;
    return list[Math.min(idx, list.length - 1)];
  }

  /** All accounts for a user, in creation order. */
  listAccounts(telegramId: number): UserRecord[] {
    return this.db.accounts[String(telegramId)] ?? [];
  }

  activeIndex(telegramId: number): number {
    return this.db.active[String(telegramId)] ?? 0;
  }

  /** Switch the active account. Returns the newly-active record, or undefined. */
  switchAccount(telegramId: number, index: number): UserRecord | undefined {
    const list = this.db.accounts[String(telegramId)];
    if (!list || index < 0 || index >= list.length) return undefined;
    this.db.active[String(telegramId)] = index;
    this.flush();
    return list[index];
  }

  /**
   * Upsert by (telegramId, address): replaces the matching account in place, or
   * appends a NEW account and makes it active. This keeps every existing
   * `saveUser` caller working while enabling multi-account onboarding.
   */
  saveUser(user: UserRecord): void {
    const id = String(user.telegramId);
    const list = (this.db.accounts[id] ??= []);
    const at = list.findIndex((u) => u.address.toLowerCase() === user.address.toLowerCase());
    if (at >= 0) {
      list[at] = user;
    } else {
      list.push(user);
      this.db.active[id] = list.length - 1; // new account becomes active
    }
    this.flush();
  }

  /**
   * The referrer of a Telegram user, read from their PRIMARY account (account
   * [0]) so referral crediting is consistent no matter which of their accounts
   * is active when they trade (Audit R3 F7 — referral is per-user, not
   * per-account).
   */
  referrerOf(telegramId: number): number | undefined {
    return this.db.accounts[String(telegramId)]?.[0]?.referredBy;
  }

  /** How many distinct users this telegramId has referred (deep-link). */
  countReferrals(telegramId: number): number {
    const seen = new Set<number>();
    for (const [id, list] of Object.entries(this.db.accounts)) {
      if (list[0]?.referredBy === telegramId) seen.add(Number(id));
    }
    return seen.size;
  }

  /**
   * Record a referral reward paid to a referrer (split at source on-chain, so
   * this ledger is a transparency/history record, not an unsettled liability).
   * Keyed referrerId → token symbol → cumulative raw amount, plus a trade count.
   */
  recordReferralEarning(referrerId: number, symbol: string, rawAmount: bigint): void {
    const led = (this.db.referralEarnings ??= {});
    const rec = (led[String(referrerId)] ??= { trades: 0, byToken: {} });
    rec.trades += 1;
    rec.byToken[symbol] = (BigInt(rec.byToken[symbol] ?? "0") + rawAmount).toString();
    this.flush();
  }

  referralEarnings(referrerId: number): { trades: number; byToken: Record<string, string> } {
    return this.db.referralEarnings?.[String(referrerId)] ?? { trades: 0, byToken: {} };
  }

  /** Log an agent fee that failed to collect after the main action succeeded. */
  recordOwedFee(f: OwedFee): void {
    (this.db.owedFees ??= []).push(f);
    this.flush();
  }

  owedFees(): OwedFee[] {
    return this.db.owedFees ?? [];
  }

  // ── Proactive alerts (opt-in) ───────────────────────────────────────────────
  alertPrefs(telegramId: number): AlertPrefs {
    return this.db.alertPrefs?.[String(telegramId)] ?? { trove: false, rewards: false, epoch: false };
  }

  setAlertPref(telegramId: number, key: keyof AlertPrefs, on: boolean): AlertPrefs {
    const map = (this.db.alertPrefs ??= {});
    const prefs = { ...this.alertPrefs(telegramId), [key]: on };
    map[String(telegramId)] = prefs;
    this.flush();
    return prefs;
  }

  /** Every user with at least one alert enabled (for the keeper sweep). */
  alertSubscribers(): Array<{ telegramId: number; prefs: AlertPrefs }> {
    return Object.entries(this.db.alertPrefs ?? {})
      .filter(([, p]) => p.trove || p.rewards || p.epoch)
      .map(([id, prefs]) => ({ telegramId: Number(id), prefs }));
  }

  alertState(telegramId: number): AlertState {
    return this.db.alertState?.[String(telegramId)] ?? {};
  }

  patchAlertState(telegramId: number, patch: Partial<AlertState>): void {
    const map = (this.db.alertState ??= {});
    map[String(telegramId)] = { ...this.alertState(telegramId), ...patch };
    this.flush();
  }

  // ── Pending deep-link referrals (persisted; 24h TTL) ───────────────────────
  setPendingReferral(newUser: number, referrer: number, ttlMs: number): void {
    const map = (this.db.pendingReferrals ??= {});
    map[String(newUser)] = { referrer, expiresAt: Date.now() + ttlMs };
    // Bounded sweep so abandoned onboardings can't grow the store forever.
    const now = Date.now();
    for (const [k, v] of Object.entries(map)) if (v.expiresAt < now) delete map[k];
    this.flush();
  }

  /** Read WITHOUT consuming (validate first, delete only after a successful credit). */
  peekPendingReferral(newUser: number): number | undefined {
    const e = this.db.pendingReferrals?.[String(newUser)];
    return e && e.expiresAt >= Date.now() ? e.referrer : undefined;
  }

  clearPendingReferral(newUser: number): void {
    if (this.db.pendingReferrals?.[String(newUser)] !== undefined) {
      delete this.db.pendingReferrals[String(newUser)];
      this.flush();
    }
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

  // ── Automation: DCA schedules ──────────────────────────────────────────────
  addSchedule(s: DcaSchedule): void {
    this.db.schedules.push(s);
    this.flush();
  }
  listSchedules(telegramId: number): DcaSchedule[] {
    return this.db.schedules.filter((s) => s.telegramId === telegramId);
  }
  /** All schedules due to run at/after `nowIso` (for the keeper). */
  dueSchedules(nowIso: string): DcaSchedule[] {
    return this.db.schedules.filter((s) => s.active && s.nextRunAt <= nowIso);
  }
  updateSchedule(id: string, patch: Partial<DcaSchedule>): void {
    const s = this.db.schedules.find((x) => x.id === id);
    if (s) { Object.assign(s, patch); this.flush(); }
  }
  cancelSchedule(id: string): boolean {
    const s = this.db.schedules.find((x) => x.id === id);
    if (!s) return false;
    s.active = false;
    this.flush();
    return true;
  }
  newId(): string { return randomUUID(); }

  // ── Automation: emergency pause / kill-switch ──────────────────────────────
  /** Operator-level emergency stop for ALL scheduled automation. */
  isKeeperPaused(): boolean {
    return this.db.keeperPaused === true;
  }
  setKeeperPaused(paused: boolean): void {
    this.db.keeperPaused = paused;
    this.flush();
  }
  /** Per-user pause: freezes that user's schedules without cancelling them. */
  isUserPaused(telegramId: number): boolean {
    return (this.db.pausedUsers ?? []).includes(telegramId);
  }
  setUserPaused(telegramId: number, paused: boolean): void {
    const list = new Set(this.db.pausedUsers ?? []);
    if (paused) list.add(telegramId);
    else list.delete(telegramId);
    this.db.pausedUsers = [...list];
    this.flush();
  }

  // ── Automation: auto-compound preference ───────────────────────────────────
  setAutoCompound(pref: AutoCompound): void {
    const i = this.db.autoCompound.findIndex(
      (a) => a.telegramId === pref.telegramId && a.accountAddress.toLowerCase() === pref.accountAddress.toLowerCase(),
    );
    if (i >= 0) this.db.autoCompound[i] = pref;
    else this.db.autoCompound.push(pref);
    this.flush();
  }
  getAutoCompound(telegramId: number, accountAddress: Address): AutoCompound | undefined {
    return this.db.autoCompound.find(
      (a) => a.telegramId === telegramId && a.accountAddress.toLowerCase() === accountAddress.toLowerCase(),
    );
  }
}

export const store = new Store();
