import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Can the Postgres-backed store lose a wallet?
 *
 * On a host with no disk (Render free) the local file is wiped on every
 * restart, so Postgres is the only durable copy. This runs a real Postgres
 * wire server (PGlite) and checks the properties that keep it safe:
 *
 *   - a restart on an empty disk gets every account back
 *   - an unreachable database refuses to start instead of starting empty
 *   - a stale instance (Render overlaps old + new on deploy) cannot overwrite
 *     the new one, and finds out it must stop
 *   - a write that fails is retried until it lands, and durable() tells the
 *     truth meanwhile
 *   - an existing local store is uploaded on first boot, never clobbered
 *
 *   npm run remotecheck
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "mezo-remote-"));
  dirs.push(d);
  return d;
};
process.env.DATA_DIR = freshDir();

const { hydrateFromRemote, PgMirror, countAccounts } = await import("../src/db/remote.js");
const { Store } = await import("../src/db/store.js");

let fail = 0;
const ok = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
};

const PORT = 55432;
const db = await PGlite.create();
let server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 10 });
await server.start();
const URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const network = "testnet";
const user = (id: number, address: string) =>
  ({ telegramId: id, address, sealedKey: "ciphertext-only", createdAt: new Date().toISOString() }) as never;
const rowBody = async () =>
  (await db.query<{ body: string }>(`select body from mezo_agent_store where key = 'mezo-agent.${network}'`)).rows[0]?.body;

// 1. Fresh database, empty disk.
const dirA = freshDir();
const a = await hydrateFromRemote({ url: URL, dataDir: dirA, network });
ok("hydrate on an empty database starts empty (no row yet)", a !== undefined && (await rowBody()) === undefined);
const storeA = new Store(dirA);
storeA.saveUser(user(111, "0x1111111111111111111111111111111111111111"));
ok("durable() confirms the write reached Postgres", (await storeA.durable(5_000)) === true);
ok("Postgres holds the account", countAccounts((await rowBody()) ?? "") === 1);

// 2. Restart on a WIPED disk (what Render free does): the account comes back.
await a!.drain();
const dirB = freshDir();
const b = await hydrateFromRemote({ url: URL, dataDir: dirB, network });
const storeB = new Store(dirB);
ok("after a restart on an empty disk the wallet is restored", storeB.getUser(111)?.address === "0x1111111111111111111111111111111111111111");

// 3. Stale instance. B now owns the row; a second instance C takes over, and
//    B (the old one in a deploy overlap) tries to write.
const dirC = freshDir();
const c = new PgMirror(URL, `mezo-agent.${network}`);
const cBody = await c.hydrate();
writeFileSync(join(dirC, `mezo-agent.${network}.json`), cBody!);
let bLost = false;
b!.onLeaseLost = () => { bLost = true; };
storeB.saveUser(user(222, "0x2222222222222222222222222222222222222222"));
ok("the superseded instance's write is reported NOT durable", (await storeB.durable(5_000)) === false);
ok("…and it is told to stop", bLost);
ok("…and Postgres was not overwritten by it", countAccounts((await rowBody()) ?? "") === 1);
c.enqueue(JSON.stringify({ ...JSON.parse(cBody!), active: { "111": 0 } }));
ok("the new owner can still write", (await c.durable(5_000)) === true);
await c.drain();

// 4. A write while the database is down is retried until it lands.
const dirD = freshDir();
const d = await hydrateFromRemote({ url: URL, dataDir: dirD, network, retryMs: 200 });
const storeD = new Store(dirD);
await server.stop();
storeD.saveUser(user(333, "0x3333333333333333333333333333333333333333"));
ok("while Postgres is down, durable() does not claim success", (await storeD.durable(1_000)) === false);
ok("…and status() reports unsynced", d!.status().synced === false);
server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 10 });
await server.start();
ok("once it is back, the queued write lands", (await storeD.durable(15_000)) === true);
ok("…with the new account in it", countAccounts((await rowBody()) ?? "") === 2);
await d!.drain();

// 5. Unreachable database at boot: refuse to start rather than start empty.
const dirE = freshDir();
let threw = false;
try {
  await hydrateFromRemote({ url: "postgres://postgres:x@127.0.0.1:1/postgres", dataDir: dirE, network, attempts: 2, retryMs: 50 });
} catch (e) {
  threw = /Refusing to start/.test((e as Error).message);
}
ok("an unreachable database refuses to start", threw);
ok("…and writes no empty store to disk", !existsSync(join(dirE, `mezo-agent.${network}.json`)));

// 6. First boot with a store already on disk and no row: upload, don't wipe.
await db.query(`delete from mezo_agent_store`);
const dirF = freshDir();
const legacy = new Store(dirF); // no mirror for this one: writes locally only
legacy.saveUser(user(444, "0x4444444444444444444444444444444444444444"));
const local = readFileSync(join(dirF, `mezo-agent.${network}.json`), "utf8");
const f = await hydrateFromRemote({ url: URL, dataDir: dirF, network });
ok("an existing local store is uploaded on first boot", (await rowBody()) === local);
await f!.drain();

await server.stop();
await db.close();
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (fail > 0) {
  console.log(`\n✗ remotecheck: ${fail} FAILED`);
  process.exit(1);
}
console.log("\n✓ remotecheck: all passed");
process.exit(0);
