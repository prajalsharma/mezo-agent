/**
 * /export flow checks — drives the real bot with a mocked Telegram API.
 * Proves: warning precedes reveal, watch-only refuses, cancel reveals nothing,
 * and the reveal schedules self-deletion.
 */
import "./_testenv.js";
import { buildBot } from "../src/bot/bot.js";
import { createWallet, setMode } from "../src/wallet/walletService.js";

const bot = buildBot();
bot.botInfo = { id: 1, is_bot: true, first_name: "T", username: "t_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any;
const captured: { method: string; payload: any }[] = [];
bot.api.config.use(async (_p, method, payload) => {
  captured.push({ method, payload });
  return { ok: true, result: method === "sendMessage" ? { message_id: captured.length, date: 0, chat: { id: 7, type: "private" } } : true } as any;
});
await bot.init();

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${n}`); if (!c) failures++; };
const msg = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 0, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "U" }, text, entities: [{ type: "bot_command", offset: 0, length: (text.split(" ")[0] ?? text).length }] } }) as any;
const tap = (id: number, data: string) => ({ update_id: id, callback_query: { id: `c${id}`, from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "ci", message: { message_id: id, date: 0, chat: { id: 7, type: "private" }, from: bot.botInfo, text: "x" }, data } }) as any;

// no account yet
await bot.handleUpdate(msg(1, "/export"));
check("no account → helpful refusal", /No account yet/.test(captured.at(-1)?.payload?.text ?? ""));

const user = await createWallet(7);
captured.length = 0;
await bot.handleUpdate(msg(2, "/export"));
const warn = captured.find(c => c.method === "sendMessage");
check("warning shown BEFORE any reveal", /fully controls your funds/.test(warn?.payload?.text ?? ""));
check("warning contains no key material", !(warn?.payload?.text ?? "").includes(user.address.slice(2, 10)));
const markup = JSON.stringify(warn?.payload?.reply_markup ?? {});
check("confirm + cancel buttons present", markup.includes("wallet:export-confirm"));

// The button must carry a SINGLE-USE token, not a constant string. A constant
// left every export card ever rendered permanently armed.
const tokenMatch = markup.match(/wallet:export-confirm:([A-Za-z0-9_-]+)/);
check("confirm button carries a single-use token", Boolean(tokenMatch));
const token = tokenMatch?.[1] ?? "";

// A tap with NO token (what an old card carried) must reveal nothing.
captured.length = 0;
await bot.handleUpdate(tap(3, "wallet:export-confirm"));
check("bare (stale-card) confirm reveals nothing", !captured.some(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? "")));

// A tap with the WRONG token must reveal nothing either.
captured.length = 0;
await bot.handleUpdate(tap(4, "wallet:export-confirm:not-the-token"));
check("wrong-token confirm reveals nothing", !captured.some(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? "")));

// Re-arm (the failed attempts consumed the authorisation) and cancel.
captured.length = 0;
await bot.handleUpdate(msg(5, "/export"));
const t2 = JSON.stringify(captured.find(c => c.method === "sendMessage")?.payload?.reply_markup ?? {}).match(/wallet:export-cancel:([A-Za-z0-9_-]+)/)?.[1] ?? "";
captured.length = 0;
await bot.handleUpdate(tap(6, `wallet:export-cancel:${t2}`));
check("cancel → nothing revealed", !captured.some(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? "")));

// Re-arm and confirm properly.
captured.length = 0;
await bot.handleUpdate(msg(7, "/export"));
const t3 = JSON.stringify(captured.find(c => c.method === "sendMessage")?.payload?.reply_markup ?? {}).match(/wallet:export-confirm:([A-Za-z0-9_-]+)/)?.[1] ?? "";
captured.length = 0;
await bot.handleUpdate(tap(8, `wallet:export-confirm:${t3}`));
const reveal = captured.find(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? ""));
check("confirm with the right token → key revealed", Boolean(reveal));
// The copy must not promise a guarantee an in-process timer cannot keep.
check("reveal describes deletion as best-effort, not guaranteed",
  /best-effort/i.test(reveal?.payload?.text ?? "") && !/auto-deletes/i.test(reveal?.payload?.text ?? ""));

// SINGLE USE: replaying the very same token must not reveal it again.
captured.length = 0;
await bot.handleUpdate(tap(9, `wallet:export-confirm:${t3}`));
check("replaying a used token reveals nothing", !captured.some(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? "")));

// watch-only refusal
setMode(7, "watch-only");
captured.length = 0;
await bot.handleUpdate(msg(10, "/export"));
const t4 = JSON.stringify(captured.find(c => c.method === "sendMessage")?.payload?.reply_markup ?? {}).match(/wallet:export-confirm:([A-Za-z0-9_-]+)/)?.[1] ?? "";
captured.length = 0;
await bot.handleUpdate(tap(11, `wallet:export-confirm:${t4}`));
check("watch-only → export refused", captured.some(c => /watch-only/.test(c.payload?.text ?? "")) && !captured.some(c => /0x[0-9a-f]{64}/i.test(c.payload?.text ?? "")));

console.log(failures === 0 ? "\nAll export checks passed. ✅" : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
