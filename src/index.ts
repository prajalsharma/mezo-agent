import { config } from "./config.js";
import { createBot } from "./gateway/bot.js";
import { signer } from "./signer/signer.js";

/**
 * Entry point. Starts the Telegram gateway in long-polling mode. Webhook mode
 * (README §11) is a config swap in production.
 */
async function main(): Promise<void> {
  if (!config.telegramToken) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set.\n" +
        "Set it in .env (copy from .env.example), or run `npm run demo` to exercise the pipeline offline.",
    );
    process.exit(1);
  }

  const bot = createBot();
  console.log(
    `Mezo agent starting — chainId=${config.chain.chainId}, ` +
      `llm=${config.llm.provider}, signer=${signer.mode}`,
  );

  process.once("SIGINT", () => void bot.stop());
  process.once("SIGTERM", () => void bot.stop());

  await bot.start({
    onStart: (info) => console.log(`Connected as @${info.username}.`),
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
