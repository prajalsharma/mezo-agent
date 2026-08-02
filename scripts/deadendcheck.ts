export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * DEAD-END AUDIT — every capability the bot advertises must be reachable AND
 * executable. Checks, per intent action:
 *   1. PARSE     — can the deterministic parser produce it from natural language?
 *   2. HANDLER   — is it routed (dispatch surface or gateway handler)?
 *   3. EXECUTE   — does the builder produce an executable plan on this network,
 *                  or is it permanently preview-only / gated?
 *   4. UI        — is it reachable from a button or slash command?
 * A capability that parses but can never execute is a dead end for the user.
 */
const owner = "0x2B325c6768a11B2E7Cc9cF3EF8513A426677Bde9" as `0x${string}`;
const { registry } = await import("../src/registry/registry.js");
const { fallbackParse } = await import("../src/llm/adapter.js");
const { buildActionPlan } = await import("../src/surfaces/dispatch.js");
const { mainMenu, screenCard, tipCard } = await import("../src/bot/menu.js");

const syms = registry.knownTokenSymbols();
const pool = registry.pools()[0]?.pair.join("/") ?? "BTC/MUSD";

// action -> a natural-language phrase a user would realistically type
const PHRASES: Record<string, string> = {
  swap: "swap 100 MUSD to BTC",
  borrow: "borrow 2000 MUSD against 0.1 BTC",
  repay: "repay 500 MUSD",
  adjust: "add 0.05 BTC collateral",
  closeTrove: "close trove",
  vaultDeposit: "deposit 100 MUSD into vault",
  stakeLp: `stake LP ${pool}`,
  unstakeLp: `unstake LP ${pool}`,
  claim: "claim all",
  lock: "lock 0.2 BTC for 28 days",
  extendLock: "extend lock 3 by 30 days",
  vote: "vote optimally",
  marketBrowse: "browse market",
  marketBuy: "buy listing 42",
  zap: `zap 0.01 BTC into ${pool}`,
  matchbox: "pair venft 1 with vemezo 2",
  veTransfer: "transfer venft 1 to 0x1111111111111111111111111111111111111111",
  veMerge: "merge venft 1 into venft 2",
  dcaCreate: "dca 50 MUSD to BTC every 24h",
  dcaCancel: "cancel dca",
  autoCompound: "auto-compound on",
  account: "new account",
  portfolio: "portfolio",
};
// Handled by the gateway (bot.ts switch), not the action dispatcher.
const GATEWAY = new Set(["swap", "portfolio", "account", "dcaCreate", "dcaCancel", "autoCompound"]);

// Collect every callback + command exposed in the UI.
const uiTargets = new Set<string>();
const cb = (kb: any) => (kb.inline_keyboard ?? []).flat().map((x: any) => x.callback_data).filter(Boolean);
cb(mainMenu()).forEach((c: string) => uiTargets.add(c));
for (const s of ["swap","borrow","earn","lockvote","automate","alerts","settings","help","learn","accounts","portfolio"]) {
  const c = await screenCard(s, 1); if (c) cb(c.keyboard).forEach((x: string) => uiTargets.add(x));
}
for (const k of ["borrow_open","borrow_repay","borrow_adjust","earn_stake","earn_vault","earn_zap","lock","extendlock","vote","dca","switch","export","upgrade"]) {
  const c = await tipCard(k, 1); if (c) { uiTargets.add(`tip:${k}`); cb(c.keyboard).forEach((x: string) => uiTargets.add(x)); }
}
const uiBlob = [...uiTargets].join(" ");

type Row = { action: string; parse: string; handler: string; exec: string };
const rows: Row[] = [];
for (const [action, phrase] of Object.entries(PHRASES)) {
  const parsed = fallbackParse(phrase, syms) as any;
  const parse = parsed.action === action ? "OK" : `MISS (${parsed.action})`;

  let handler = GATEWAY.has(action) ? "gateway" : "—";
  let exec = "—";
  if (!GATEWAY.has(action)) {
    try {
      const plan = await buildActionPlan(parsed.action === action ? parsed : ({ action } as any), owner);
      if (!plan) { handler = "NO HANDLER"; }
      else {
        handler = "dispatch";
        exec = plan.executable ? "executable" : `GATED: ${(plan.gatedReason ?? "").slice(0, 58)}`;
      }
    } catch (e) {
      handler = "dispatch";
      exec = `throws: ${(e instanceof Error ? e.message : String(e)).slice(0, 58)}`;
    }
  }
  rows.push({ action, parse, handler, exec });
}

console.log("\nDEAD-END AUDIT — " + registry.networkName());
console.log("action".padEnd(14), "parse".padEnd(16), "handler".padEnd(12), "execute");
console.log("-".repeat(96));
const problems: string[] = [];
for (const r of rows) {
  console.log(r.action.padEnd(14), r.parse.padEnd(16), r.handler.padEnd(12), r.exec);
  if (r.parse.startsWith("MISS")) problems.push(`${r.action}: natural language does not parse (${r.parse})`);
  if (r.handler === "NO HANDLER") problems.push(`${r.action}: no handler — dead end`);
  if (r.exec.startsWith("GATED")) problems.push(`${r.action}: preview-only on this network`);
}
console.log("\nUI reachability:");
for (const a of Object.keys(PHRASES)) {
  const hit = uiBlob.includes(a.toLowerCase()) || uiBlob.includes(a);
  if (!hit) problems.push(`${a}: no button/tip references it`);
}
console.log(`  ${uiTargets.size} distinct UI targets scanned`);

console.log(problems.length ? `\n⚠️  ${problems.length} ISSUE(S):` : "\n✅ no dead ends");
for (const p of problems) console.log("  - " + p);
