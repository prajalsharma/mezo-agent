import { buildBot, startupBanner } from "./bot/bot.js";
import { runPreflight, formatPreflightText } from "./core/preflight.js";
import { log, errMsg } from "./core/log.js";

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

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  // 2. Ensure polling can actually receive updates.
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    log.info("startup.webhook-cleared");
  } catch (err) {
    log.warn("startup.deleteWebhook-failed", { error: errMsg(err) });
  }

  await bot.start({
    onStart: (me) => console.log(`✅ Bot @${me.username} is live (long-polling). Send /start or /diag.`),
  });
}

main().catch((err) => {
  console.error("Fatal:", errMsg(err));
  process.exit(1);
});
