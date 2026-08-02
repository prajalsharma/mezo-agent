import type { Context } from "grammy";
import { getUser, createAccount, listAccounts, activeIndex, switchAccount } from "../../wallet/walletService.js";
import { createDcaSchedule, ScheduleError } from "../../keeper/scheduler.js";
import { store } from "../../db/store.js";
import { registry } from "../../registry/registry.js";
import type { AccountIntent, DcaCreateIntent, DcaCancelIntent, AutoCompoundIntent } from "../../llm/intent.js";
import { b, i, code, esc } from "../format.js";

/**
 * Phase 5 meta/automation handlers: multi-account management, DCA schedules
 * (pre-authorized, scoped, revocable), and epoch auto-compound preference.
 */

export async function handleAccount(ctx: Context, intent: AccountIntent): Promise<void> {
  const id = ctx.from?.id;
  if (!id) return;
  if (!getUser(id)) { await ctx.reply("No account yet. Send /start."); return; }

  if (intent.op === "new") {
    const acct = await createAccount(id);
    await ctx.reply(`${b("New account created and activated.")}\n${code(acct.address)}`, { parse_mode: "HTML" });
    return;
  }
  if (intent.op === "switch") {
    if (intent.index === undefined) { await ctx.reply("Which account number? e.g. \"switch to account 2\"."); return; }
    const acct = switchAccount(id, intent.index);
    if (!acct) { await ctx.reply(`No account #${intent.index}. Use \"list accounts\".`); return; }
    await ctx.reply(`${b(`Switched to account ${intent.index}.`)}\n${code(acct.address)}`, { parse_mode: "HTML" });
    return;
  }
  // list
  const accts = listAccounts(id);
  const active = activeIndex(id);
  const lines = accts.map((a, idx) => `${idx === active ? "▶️" : "  "} #${idx} ${code(a.address)}${a.mode === "watch-only" ? " (watch-only)" : ""}`);
  await ctx.reply([b("Your accounts"), ...lines, "", i("Switch with \"switch to account 1\", add with \"new account\".")].join("\n"), { parse_mode: "HTML" });
}

export async function handleDcaCreate(ctx: Context, intent: DcaCreateIntent): Promise<void> {
  const id = ctx.from?.id;
  if (!id) return;
  const user = getUser(id);
  if (!user) { await ctx.reply("No account yet. Send /start."); return; }
  try {
    const s = createDcaSchedule(user, intent);
    const every = s.everyHours % 24 === 0 ? `${s.everyHours / 24} day(s)` : `${s.everyHours} hour(s)`;
    await ctx.reply(
      [
        b("✅ DCA schedule created"),
        "",
        `Buy ${s.amount} ${s.toToken} with ${s.fromToken} every ${every}` +
          (s.remaining > 0 ? `, ${s.remaining} times.` : ", until cancelled."),
        `Schedule id: ${code(s.id.slice(0, 8))}`,
        "",
        i("Each run is scoped by your spending limits and can be cancelled with \"cancel dca\". Execution runs only when swaps are enabled on this deployment."),
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  } catch (e) {
    await ctx.reply(`⚠️ ${esc(e instanceof ScheduleError ? e.message : String(e))}`, { parse_mode: "HTML" });
  }
}

export async function handleDcaCancel(ctx: Context, intent: DcaCancelIntent): Promise<void> {
  const id = ctx.from?.id;
  if (!id) return;
  const schedules = store.listSchedules(id).filter((s) => s.active);
  if (!intent.scheduleId) {
    if (schedules.length === 0) {
      await ctx.reply(
        [
          b("You have no active DCA schedules yet."),
          "",
          "Create one in plain language, e.g.:",
          code("dca 50 MUSD to BTC every 24h"),
          code("dca 100 MUSD to mUSDC every 7 days for 4 times"),
          "",
          i("DCA buys a fixed amount on a repeating schedule, each run scoped by your spending limits."),
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }
    const lines = schedules.map((s) => `• ${code(s.id.slice(0, 8))} - ${s.amount} ${s.fromToken}→${s.toToken} every ${s.everyHours}h`);
    await ctx.reply([b("Active DCA schedules"), ...lines, "", i("Cancel one: \"cancel dca <id>\".")].join("\n"), { parse_mode: "HTML" });
    return;
  }
  const match = schedules.find((s) => s.id.startsWith(intent.scheduleId!));
  if (!match || !store.cancelSchedule(match.id)) { await ctx.reply("No matching active schedule."); return; }
  await ctx.reply(`🛑 Cancelled DCA ${code(match.id.slice(0, 8))}.`, { parse_mode: "HTML" });
}

export async function handleAutoCompound(ctx: Context, intent: AutoCompoundIntent): Promise<void> {
  const id = ctx.from?.id;
  if (!id) return;
  const user = getUser(id);
  if (!user) { await ctx.reply("No account yet. Send /start."); return; }
  const into = intent.intoToken && registry.tryToken(intent.intoToken) ? registry.token(intent.intoToken).symbol : "BTC";
  store.setAutoCompound({ telegramId: id, accountAddress: user.address, enabled: intent.enabled, intoToken: into });
  await ctx.reply(
    intent.enabled
      ? `${b("Auto-compound enabled.")}\nAt each epoch, claimable rewards are claimed and swapped into ${code(into)}. ${i("Runs within your spending limits; execution activates when swaps/claims are enabled.")}`
      : `${b("Auto-compound disabled.")}`,
    { parse_mode: "HTML" },
  );
}
