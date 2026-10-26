export {};
/**
 * The /healthz endpoint reports polling liveness, not just "process is up".
 *
 * Wires a real grammY Bot to a fake Telegram (via the client `fetch` option),
 * installs the same transformer as src/index.ts, and checks the HTTP answer
 * before polling, after a successful getUpdates, and once polling goes stale.
 */
import { Bot } from "grammy";
const { markPolled, healthState, startHealthServer } = await import("../src/core/health.js");

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
};

const fakeFetch = (async (url: string | URL) => {
  const method = String(url).split("/").pop();
  const result = method === "getUpdates" ? [] : true;
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const bot = new Bot("123456:" + "x".repeat(35), { client: { fetch: fakeFetch } });
bot.api.config.use(async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  if (method === "getUpdates" && res.ok) markPolled();
  return res;
});

const server = startHealthServer(0);
await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;
const get = () => fetch(`http://127.0.0.1:${port}/healthz`).then(async (r) => ({ code: r.status, body: (await r.json()) as { status: string } }));

let r = await get();
check("503 'starting' before the first poll", r.code === 503 && r.body.status === "starting");

await bot.api.sendMessage(1, "hi");
r = await get();
check("a non-getUpdates call does not count as polling", r.code === 503);

await bot.api.getUpdates({ timeout: 0 });
r = await get();
check("200 'ok' right after a successful getUpdates", r.code === 200 && r.body.status === "ok");

const later = healthState(Date.now() + 4 * 60 * 1000);
check("reports 'polling-stalled' after 4 minutes with no poll", !later.ok && later.status === "polling-stalled");

r = await fetch(`http://127.0.0.1:${port}/other`).then((x) => ({ code: x.status, body: { status: "" } }));
check("unknown paths are 404", r.code === 404);

server.close();
if (failures > 0) { console.log(`\n✗ healthcheck: ${failures} FAILED`); process.exit(1); }
console.log("\n✓ healthcheck: all passed");
