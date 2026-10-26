import { createServer, type Server } from "node:http";
import { log } from "./log.js";

/**
 * Liveness for hosts that restart on a failing health check (Render).
 *
 * A crashed process is easy: the platform sees the exit and restarts it. The
 * failure that actually leaves users unanswered is a process that is still
 * alive but no longer polling Telegram — a hung network call, a wedged event
 * loop. Nothing exits, so nothing restarts it.
 *
 * So "healthy" means "Telegram answered a getUpdates recently", not "the
 * process is up". Long polling returns at least every ~30s even with no
 * messages, so a gap of STALE_MS means polling has stopped.
 *
 * Only started when PORT is set. Render web services set it; local dev and
 * workers don't, so nothing changes there.
 */
const STALE_MS = 3 * 60 * 1000;

let lastPollAt = 0;

/** Record a successful getUpdates round-trip. */
export function markPolled(): void {
  lastPollAt = Date.now();
}

export function healthState(now = Date.now()): { ok: boolean; status: string; lastPollAgoSec?: number } {
  if (lastPollAt === 0) return { ok: false, status: "starting" };
  const ago = now - lastPollAt;
  return { ok: ago <= STALE_MS, status: ago <= STALE_MS ? "ok" : "polling-stalled", lastPollAgoSec: Math.round(ago / 1000) };
}

export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      const state = healthState();
      res.writeHead(state.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => log.info("health.listening", { port }));
  return server;
}
