import { buildBot, startupBanner } from "./bot/bot.js";

/**
 * Entry point. Phase 1 runs the bot in long-polling mode for local development.
 * Production switches to webhook mode behind the Gateway (architecture §3) — the
 * handler wiring is unchanged.
 */
async function main() {
  console.log(startupBanner());
  const bot = buildBot();

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  await bot.start({
    onStart: (me) => console.log(`Bot @${me.username} is live. Send /start.`),
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
