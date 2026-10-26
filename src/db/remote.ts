import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { log, errMsg } from "../core/log.js";

/**
 * Postgres as the durable home of the store, for hosts with no persistent disk
 * (Render's free tier wipes the filesystem on every restart and redeploy).
 *
 * The JSON file under DATA_DIR stays exactly as it is - the Store still reads
 * and writes it synchronously - but it becomes a CACHE. Postgres holds the
 * source of truth:
 *
 *   boot   hydrate(): pull the row and write it to the local file BEFORE the
 *          Store is imported, so the Store loads real data. If the database
 *          cannot be reached, refuse to start: starting empty would let the
 *          first write replace every user's wallet with nothing.
 *   write  every Store flush hands the whole body to enqueue(). Writes are
 *          serialized and coalesced (latest wins), retried with backoff.
 *   stop   drain() on SIGTERM, so a redeploy does not drop the last write.
 *
 * LEASE. Render runs the old and new instance side by side for a moment during
 * a deploy. Without a guard the old one could write a stale copy after the new
 * one loaded, silently undoing whatever the new one does next. So hydrate()
 * claims the row (owner = this instance), every write is conditional on still
 * owning it, and an instance that finds itself superseded stops writing and
 * exits. A write it could not land is reported as not durable, never as saved.
 *
 * Only ciphertext reaches the database: sealed keys are encrypted with
 * MASTER_ENCRYPTION_KEY, which stays in the host's env. The body is never logged.
 */

const TABLE = "mezo_agent_store";

export class LeaseLostError extends Error {
  constructor() {
    super("another instance now owns the store; this one must stop writing");
  }
}

export class PgMirror {
  readonly owner = randomUUID();
  private readonly sql: postgres.Sql;
  private pending?: string;
  private writing = false;
  private seq = 0;
  private savedSeq = 0;
  private lost = false;
  private closed = false;
  private lastError?: string;
  private waiters: Array<{ seq: number; resolve: (ok: boolean) => void }> = [];
  /** Called once if another instance takes the store over. */
  onLeaseLost: () => void = () => {};

  constructor(url: string, private readonly key: string, private readonly retryMs = 2_000) {
    // max 1: writes are serialized anyway, and free Postgres tiers cap connections.
    this.sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
  }

  /** Create the table, claim the row, and return its body (undefined if none yet). */
  async hydrate(): Promise<string | undefined> {
    await this.sql.unsafe(
      `create table if not exists ${TABLE} (
         key text primary key,
         body text not null,
         owner text not null,
         version bigint not null default 1,
         updated_at timestamptz not null default now()
       )`,
    );
    const rows = await this.sql<{ body: string }[]>`
      update ${this.sql(TABLE)} set owner = ${this.owner}, updated_at = now()
      where key = ${this.key} returning body`;
    return rows[0]?.body;
  }

  /** First upload of an existing local store (no row yet). Never overwrites a row. */
  async seed(body: string): Promise<boolean> {
    const rows = await this.sql`
      insert into ${this.sql(TABLE)} (key, body, owner) values (${this.key}, ${body}, ${this.owner})
      on conflict (key) do nothing returning key`;
    return rows.length > 0;
  }

  private async write(body: string): Promise<void> {
    const rows = await this.sql`
      insert into ${this.sql(TABLE)} (key, body, owner) values (${this.key}, ${body}, ${this.owner})
      on conflict (key) do update
        set body = excluded.body, version = ${this.sql(TABLE)}.version + 1, updated_at = now()
        where ${this.sql(TABLE)}.owner = ${this.owner}
      returning key`;
    if (rows.length === 0) throw new LeaseLostError();
  }

  /** Queue the latest full store body. Returns immediately; see durable(). */
  enqueue(body: string): void {
    if (this.lost || this.closed) return;
    this.pending = body;
    this.seq++;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending !== undefined && !this.lost) {
        const body = this.pending;
        const seq = this.seq;
        this.pending = undefined;
        try {
          await this.write(body);
          this.savedSeq = seq;
          if (this.lastError) log.info("store.remote-recovered");
          this.lastError = undefined;
          this.settle();
        } catch (err) {
          if (err instanceof LeaseLostError) {
            this.lost = true;
            this.lastError = err.message;
            log.error("store.remote-lease-lost", { detail: err.message });
            this.settle();
            this.onLeaseLost();
            return;
          }
          this.lastError = errMsg(err);
          log.error("store.remote-write-failed", { error: this.lastError });
          // Keep the newest body: a write queued meanwhile supersedes this one.
          this.pending ??= body;
          await new Promise((r) => setTimeout(r, this.retryMs));
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private settle(): void {
    this.waiters = this.waiters.filter((w) => {
      if (this.lost) { w.resolve(false); return false; }
      if (this.savedSeq >= w.seq) { w.resolve(true); return false; }
      return true;
    });
  }

  /** Resolves true once everything written so far is in Postgres, false on timeout or lease loss. */
  durable(timeoutMs = 15_000): Promise<boolean> {
    if (this.lost) return Promise.resolve(false);
    if (this.savedSeq >= this.seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { seq: this.seq, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs).unref?.();
    });
  }

  async drain(timeoutMs = 10_000): Promise<boolean> {
    const ok = await this.durable(timeoutMs);
    this.closed = true;
    await this.sql.end({ timeout: 5 }).catch(() => {});
    return ok;
  }

  status(): { synced: boolean; error?: string } {
    return { synced: !this.lost && this.savedSeq >= this.seq && this.pending === undefined, error: this.lastError };
  }
}

let mirror: PgMirror | undefined;

export function remoteMirror(): PgMirror | undefined {
  return mirror;
}

function writeLocal(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Load the store from Postgres into DATA_DIR before the Store is imported.
 * No-op without DATABASE_URL. Throws (and the process must not start) if the
 * database is unreachable after retries.
 */
export async function hydrateFromRemote(opts: { url?: string; dataDir: string; network: string; attempts?: number; retryMs?: number }): Promise<PgMirror | undefined> {
  if (!opts.url) return undefined;
  const name = `mezo-agent.${opts.network}`;
  const m = new PgMirror(opts.url, name, opts.retryMs);
  const attempts = opts.attempts ?? 6;

  // Free Postgres tiers suspend when idle; the first connection can take a few seconds.
  let body: string | undefined;
  for (let n = 1; ; n++) {
    try {
      body = await m.hydrate();
      break;
    } catch (err) {
      if (n >= attempts) {
        throw new Error(
          `DATABASE_URL is set but Postgres could not be reached (${errMsg(err)}). Refusing to start: ` +
            `starting with an empty store would overwrite every saved wallet on the first write.`,
        );
      }
      log.warn("store.remote-connect-retry", { attempt: n, error: errMsg(err) });
      await new Promise((r) => setTimeout(r, (opts.retryMs ?? 2_000) * n));
    }
  }

  mkdirSync(opts.dataDir, { recursive: true });
  const path = join(opts.dataDir, `${name}.json`);
  if (body !== undefined) {
    // Postgres is the source of truth; the local file is only a cache.
    writeLocal(path, body);
    writeLocal(`${path}.bak`, body);
    log.info("store.remote-loaded", { accounts: countAccounts(body) });
  } else if (existsSync(path)) {
    // First boot against an empty database on a host that already has a store
    // on disk: upload it rather than starting over.
    const local = readFileSync(path, "utf8");
    JSON.parse(local); // never seed a corrupt file
    if (await m.seed(local)) log.info("store.remote-seeded", { accounts: countAccounts(local) });
    else throw new Error("Postgres store appeared while seeding; restart to load it.");
  } else {
    log.info("store.remote-empty");
  }
  mirror = m;
  return m;
}

export function countAccounts(body: string): number {
  try {
    return Object.keys((JSON.parse(body) as { accounts?: object }).accounts ?? {}).length;
  } catch {
    return -1;
  }
}
