import { buildBot, startupBanner } from "./bot/bot.js";
import { runPreflight, formatPreflightText } from "./core/preflight.js";
import { log, errMsg } from "./core/log.js";
import { env } from "./config/env.js";
import { startKeeper, stopKeeper } from "./keeper/scheduler.js";
import { startAlerts, stopAlerts } from "./keeper/alerts.js";
import { sweepPending } from "./bot/session.js";
import { installBotProfile } from "./bot/menu.js";
import { setBotUsername } from "./bot/handlers/menu.js";
import { markPolled, startHealthServer } from "./core/health.js";
import { remoteMirror } from "./db/remote.js";

/**
 * Entry point. Phase 1 runs the bot in long-polling mode for local development.
 * Production switches to webhook mode behind the Gateway (architecture §3).
 *
 * Startup does three things that make failures obvious instead of silent:
 *   1. Run preflight self-checks and print ✅/❌ per subsystem.
 *   2. deleteWebhook — long polling and a set webhook are mutually exclusive; a
 *      leftover webhook (e.g. from a Vercel experiment) makes getUpdates return
 *      409 Conflict and the bot receives NOTHING. Clearing it fixes a totally
 *      unresponsive bot.
 *   3. Surface any startup error loudly and exit non-zero.
 */
async function main() {
  // deploy marker: v-gemini-2 (ensures Railway builds the LLM-provider + /diag work)
  console.log(startupBanner());

  // 1. Preflight — localizes a broken subsystem before we even connect.
  const results = await runPreflight();
  console.log("Preflight:\n" + formatPreflightText(results));
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log.warn("preflight.failures", { count: failed.length, checks: failed.map((f) => f.name).join(",") });
    // config/keystore/datastore failures are fatal for wallet creation; stop.
    const fatal = failed.find((f) => f.name === "config" || f.name === "keystore" || f.name === "datastore");
    if (fatal) {
      console.error(`\n❌ Fatal: "${fatal.name}" check failed — ${fatal.detail}\nFix this before starting.`);
      process.exit(1);
    }
    console.warn("\n⚠️ Non-fatal check(s) failed (e.g. RPC). The bot will start but that feature may not work.");
  }

  const bot = buildBot();

  // Liveness for Render's health check: every successful getUpdates proves the
  // poller is alive. Only when the host gives us a PORT (see core/health.ts).
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === "getUpdates" && res.ok) markPolled();
    return res;
  });
  const healthServer = process.env.PORT ? startHealthServer(Number(process.env.PORT)) : undefined;

  // A newer instance took over the store (Render overlaps old and new during a
  // deploy). This one's writes are now refused, so stop serving at once rather
  // than accept actions it cannot save.
  const mirror = remoteMirror();
  if (mirror) {
    mirror.onLeaseLost = () => {
      log.error("shutdown.lease-lost", { detail: "a newer instance owns the store" });
      void bot.stop().finally(() => process.exit(1));
    };
  }

  // Keeper for pre-authorized automation (DCA / auto-compound). Off by default;
  // a global kill-switch (KEEPER_ENABLED) gates all scheduled execution.
  if (env.keeperEnabled) {
    startKeeper(60_000, async (telegramId, text) => {
      await bot.api.sendMessage(telegramId, text).catch((err) => {
        log.warn("keeper.send-failed", { error: errMsg(err) });
      });
    });
    console.log("⏱️  Keeper enabled (DCA / auto-compound).");
  }

  // Proactive alerts (opt-in per user via /alerts). Independent of the keeper
  // kill-switch: alerts are read-only notifications, never fund-moving.
  startAlerts(async (telegramId, text) => {
    await bot.api.sendMessage(telegramId, text).catch((err) => {
      log.warn("alerts.send-failed", { error: errMsg(err) });
    });
  });
  console.log("🔔 Alerts engine running (opt-in per user).");

  // Expiry of pending previews is lazy — only checked when that user's plan is
  // read — so an abandoned card kept a whole plan alive for the process
  // lifetime. Sweep on a slow timer.
  const pendingSweep = setInterval(() => {
    const dropped = sweepPending();
    if (dropped > 0) log.info("session.swept", { dropped });
  }, 5 * 60 * 1000);
  pendingSweep.unref?.();

  // Graceful shutdown. On every redeploy Railway sends SIGTERM to the OLD
  // instance; if it dies mid-poll it shows as "Deployment crashed". Awaiting
  // bot.stop() and exiting 0 makes the handover a clean STOP instead — and stops
  // the old poller so the new instance doesn't hit a 409 Conflict on the shared
  // Telegram token.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown.begin", { signal });
    // Stop the timers FIRST. Both stopKeeper and stopAlerts existed only on
    // paper — nothing called them — so on every redeploy a keeper tick could
    // start a swap while the process was on its way to process.exit, and be
    // killed between signing and recording it.
    try { await stopKeeper(); } catch { /* best effort */ }
    try { stopAlerts(); } catch { /* best effort */ }
    try { clearInterval(pendingSweep); } catch { /* best effort */ }
    try { healthServer?.close(); } catch { /* best effort */ }
    // Last: everything above may have written to the store.
    if (mirror && !(await mirror.drain())) log.error("shutdown.store-not-synced", { detail: "last writes may not have reached Postgres" });
    try {
      await bot.stop();
    } catch (err) {
      log.warn("shutdown.stop-failed", { error: errMsg(err) });
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // 2. Ensure polling can actually receive updates.
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    log.info("startup.webhook-cleared");
  } catch (err) {
    log.warn("startup.deleteWebhook-failed", { error: errMsg(err) });
  }

  // Install the slash-command menu + profile description/bio so the bot presents
  // a polished first impression (mirrors Trojan/Maestro/BONKbot onboarding).
  await installBotProfile(bot);

  await bot.start({
    onStart: (me) => {
      setBotUsername(me.username);
      console.log(`✅ Bot @${me.username} is live (long-polling). Send /start or /diag.`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", errMsg(err));
  process.exit(1);
});
