export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Can the datastore survive a crash mid-write?
 *
 * It holds every user's SEALED PRIVATE KEY, and it used to be persisted with a
 * bare `writeFileSync` of the whole file from ~18 call sites — no temp file, no
 * fsync, no backup — while the load path ran `JSON.parse` at module scope,
 * outside any guard, from `export const store = new Store()`. So a truncated
 * file meant the process threw at IMPORT time, before a single handler existed,
 * and with no plaintext export path every key in it was gone. On a host that
 * SIGTERMs on each redeploy that is not a hypothetical.
 *
 * This proves the three properties that fix it: writes land atomically, a
 * truncated main file falls back to the backup, and a total loss degrades to an
 * empty store rather than a process that cannot boot.
 *
 *   npx tsx scripts/storecheck.ts
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};

// Each case constructs a REAL Store over its own directory, so the constructor
// and flush() under test actually run. (Re-importing the module would not work:
// the singleton and the env config are both cached.)
import { Store } from "../src/db/store.js";
const freshStore = (dir: string) => new Store(dir);

const base = mkdtempSync(join(tmpdir(), "mezo-storecheck-"));
const dbName = `mezo-agent.${process.env.MEZO_NETWORK ?? "testnet"}.json`;

// ── 1. A normal write is atomic and leaves a backup ─────────────────────────
{
  const dir = join(base, "atomic");
  const store = freshStore(dir);
  const path = join(dir, dbName);

  store.setKeeperPaused(true);
  ok("write produces a valid database file", existsSync(path));
  ok("no temp file is left behind", !existsSync(`${path}.tmp`));
  store.setKeeperPaused(false);
  ok("second write leaves a backup of the previous state", existsSync(`${path}.bak`));

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  ok("the file parses and holds the latest value", parsed.keeperPaused === false);
}

// ── 2. A truncated main file recovers from the backup ───────────────────────
{
  const dir = join(base, "torn");
  const store = freshStore(dir);
  const path = join(dir, dbName);

  store.setUserPaused(4242, true); // write #1
  store.setUserPaused(9999, true); // write #2 — now a .bak exists
  ok("backup exists before the simulated crash", existsSync(`${path}.bak`));

  // Simulate a crash partway through writeFileSync: a half-written JSON file.
  const good = readFileSync(path, "utf8");
  writeFileSync(path, good.slice(0, Math.floor(good.length / 2)));
  ok("main file is genuinely unparseable now", (() => {
    try { JSON.parse(readFileSync(path, "utf8")); return false; } catch { return true; }
  })());

  let booted = false;
  let recovered: unknown;
  try {
    const reloaded = freshStore(dir);
    booted = true;
    recovered = reloaded.isUserPaused(4242);
  } catch { /* booted stays false */ }

  ok("the store still BOOTS after a torn write", booted);
  ok("user data survived via the backup", recovered === true);
  ok("the damaged file was quarantined, not silently overwritten",
    // the corrupt copy is preserved for forensics
    readdirSync(dir).some((f: string) => f.includes(".corrupt.")));
}

// ── 3. Total loss degrades to an empty store, never a boot failure ──────────
{
  const dir = join(base, "hopeless");
  const store = freshStore(dir);
  const path = join(dir, dbName);
  store.setKeeperPaused(true);
  store.setKeeperPaused(false); // ensure a .bak
  writeFileSync(path, "{{{ not json");
  writeFileSync(`${path}.bak`, "also not json");

  let booted = false;
  try {
    const reloaded = freshStore(dir);
    booted = true;
    ok("an unrecoverable store starts empty rather than throwing", reloaded.isKeeperPaused() === false);
  } catch (e) {
    ok("an unrecoverable store starts empty rather than throwing", false, (e as Error).message.slice(0, 60));
  }
  ok("the process is still able to boot", booted);
}

rmSync(base, { recursive: true, force: true });
console.log(fail === 0 ? "\nStore durability OK - a torn write can't destroy custody. ✅" : `\n${fail} DURABILITY FAILURE(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
