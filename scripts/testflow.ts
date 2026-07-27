// Faithful reproduction of the real Telegram wallet-creation flow.
// Drives the actual grammY bot with a mocked Telegram API so we see exactly
// what the handler does (and any error it throws) without hitting Telegram.
import "./_testenv.js";
import { buildBot } from "../src/bot/bot.js";

type Captured = { method: string; payload: any };

async function main() {
  const bot = buildBot();

  // Avoid a getMe() network call.
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "MezoAgentTest",
    username: "mezo_agent_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as any;

  // Intercept every outgoing Telegram API call; record it and return a fake OK.
  const captured: Captured[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload });
    // Minimal fake results per method used by the handlers.
    if (method === "sendMessage" || method === "sendPhoto") {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as any;
    }
    return { ok: true, result: true } as any;
  });

  await bot.init();

  // 1) Simulate /start (message update)
  console.log("=== simulate /start ===");
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 555, type: "private" },
      from: { id: 555, is_bot: false, first_name: "Alice" },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  } as any);

  // 2) Simulate tapping the "Create a new wallet" inline button.
  console.log("=== simulate tap: wallet:create ===");
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "cbq1",
      from: { id: 555, is_bot: false, first_name: "Alice" },
      chat_instance: "ci",
      message: {
        message_id: 11,
        date: 0,
        chat: { id: 555, type: "private" },
        from: bot.botInfo,
        text: "menu",
      },
      data: "wallet:create",
    },
  } as any);

  console.log("\n=== captured API calls ===");
  for (const c of captured) {
    const text = c.payload?.text ?? c.payload?.caption ?? "";
    console.log(`→ ${c.method}: ${String(text).slice(0, 90).replace(/\n/g, " ⏎ ")}`);
  }

  const created = captured.find((c) => c.method === "sendMessage" && /Wallet created/.test(c.payload?.text ?? ""));
  console.log("\nRESULT:", created ? "✅ wallet-creation reply was produced" : "❌ NO wallet-creation reply — creation path failed");
}

main().catch((e) => {
  console.error("\n❌ FLOW THREW:", e);
  process.exit(1);
});
