export {};
/**
 * Upload an existing store file into Postgres - the one-time move off a host
 * with a disk (Railway volume) onto one without (Render free + DATABASE_URL).
 *
 *   DATABASE_URL=postgres://... MEZO_NETWORK=mainnet npm run pgimport -- ./mezo-agent.mainnet.json
 *
 * Refuses to overwrite a store that is already in the database, and never
 * prints the file's contents (it holds sealed keys) - only the account count.
 * The bot must be STOPPED everywhere while this runs.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const [file] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
const network = process.env.MEZO_NETWORK;
if (!file || !url || (network !== "mainnet" && network !== "testnet")) {
  console.error("usage: DATABASE_URL=... MEZO_NETWORK=mainnet|testnet npm run pgimport -- <store.json>");
  process.exit(2);
}
const { PgMirror, countAccounts } = await import("../src/db/remote.js");

const body = readFileSync(file, "utf8");
try {
  JSON.parse(body);
} catch {
  console.error(`✗ ${file} is not valid JSON - refusing to upload it.`);
  process.exit(1);
}
const accounts = countAccounts(body);

const m = new PgMirror(url, `mezo-agent.${network}`);
const existing = await m.hydrate();
if (existing !== undefined) {
  console.error(`✗ A ${network} store is already in this database (${countAccounts(existing)} account(s)). Not overwriting it.`);
  await m.drain(1);
  process.exit(1);
}
const seeded = await m.seed(body);
await m.drain(1);
if (!seeded) {
  console.error("✗ Another process wrote the store meanwhile. Nothing uploaded.");
  process.exit(1);
}

// Read it back so success means "it is in the database", not "we sent it".
const sql = postgres(url, { max: 1, onnotice: () => {} });
const [row] = await sql<{ body: string }[]>`select body from mezo_agent_store where key = ${`mezo-agent.${network}`}`;
await sql.end();
if (row?.body !== body) {
  console.error("✗ Read-back did not match what was uploaded.");
  process.exit(1);
}
console.log(`✓ Uploaded ${file} as the ${network} store: ${accounts} account(s), verified by read-back.`);
