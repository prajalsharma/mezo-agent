import { buildBot, startupBanner } from "./bot/bot.js";
import { runPreflight, formatPreflightText } from "./core/preflight.js";
import { log, errMsg } from "./core/log.js";
import { env } from "./config/env.js";
import { startKeeper } from "./keeper/scheduler.js";
import { startAlerts } from "./keeper/alerts.js";
import { installBotProfile } from "./bot/menu.js";
import { setBotUsername } from "./bot/handlers/menu.js";

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
