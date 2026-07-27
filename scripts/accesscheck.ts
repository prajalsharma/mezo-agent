/**
 * Access-gate checks. Drives the real grammY bot with a mocked Telegram API and
 * asserts that an unlisted user reaches NO handler while an allowlisted one does.
 *
 * The allowlist is read once at module-evaluation time (config/env.js). ESM
 * hoists every import above the module body, so assigning process.env here would
 * be too late — the var must come from the actual environment:
 *
 *   npm run accesscheck        (package.json supplies TELEGRAM_ALLOWED_USER_IDS=555)
 */
import "./_testenv.js";
import { buildBot } from "../src/bot/bot.js";
import { accessRestricted, env } from "../src/config/env.js";

const ALLOWED = 555;
const STRANGER = 999;

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
}

function startUpdate(userId: number, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: userId, type: "private" },
      from: { id: userId, is_bot: false, first_name: `U${userId}` },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  } as any;
}

async function main() {
  console.log("Access gate:");
  check("allowlist parsed from env", accessRestricted && env.allowedUserIds.has(ALLOWED));
  check("stranger is not in the allowlist", !env.allowedUserIds.has(STRANGER));

  const bot = buildBot();
  bot.botInfo = {
    id: 1, is_bot: true, first_name: "MezoAgentTest", username: "mezo_agent_test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as any;

  const captured: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload });
    if (method === "sendMessage" || method === "sendPhoto") {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as any;
    }
    return { ok: true, result: true } as any;
  });
  await bot.init();

  // An unlisted user must produce ZERO outbound API calls — not even an error
  // reply, which would confirm to a scanner that the token is live.
  await bot.handleUpdate(startUpdate(STRANGER, 1));
  check("unlisted user gets no reply at all", captured.length === 0);

  // The allowlisted user must reach the real /start handler.
  await bot.handleUpdate(startUpdate(ALLOWED, 2));
  check("allowlisted user reaches the handler", captured.length > 0);

  console.log(
    failures === 0 ? "\nAll access checks passed. ✅" : `\n${failures} FAILURE(S) ✗`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n❌ ACCESS CHECK THREW:", e);
  process.exit(1);
});
