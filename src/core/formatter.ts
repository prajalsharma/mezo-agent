import type { CallPlan } from "./builder.js";
import type { SimulationResult } from "./simulator.js";

/**
 * Confirmation formatter (README §3, §5 step 5).
 *
 * Renders the decoded simulation into the plain-language summary the user sees
 * before Confirm/Cancel. This is the human-readable "what will happen" — the
 * app-level gate of the three-layer confirmation model.
 */

const ACTION_TITLES: Record<CallPlan["action"], string> = {
  borrow: "🏦 Borrow MUSD (open Trove)",
  repay: "💵 Repay MUSD",
  swap: "🔄 Swap",
  zap: "⚡ Zap into pool",
  lock: "🔒 Lock",
  vote: "🗳️ Vote",
  claim: "🎁 Claim rewards",
  portfolio: "📊 Portfolio",
};

export function formatConfirmation(plan: CallPlan, sim: SimulationResult): string {
  const lines: string[] = [];
  lines.push(`*${ACTION_TITLES[plan.action]}*`);
  lines.push("");

  for (const e of sim.effects) {
    const prefix = e.warn ? "⚠️ " : "• ";
    lines.push(`${prefix}${e.label}: ${e.value}`);
  }

  lines.push("");
  lines.push(`⛽ Est. gas: ~${sim.estGasBTC} BTC (native)`);

  if (plan.calls.length > 1) {
    lines.push("");
    lines.push(`This is a ${plan.calls.length}-step plan${plan.abortOnFailure ? " (aborts if any step fails)" : ""}:`);
    plan.calls.forEach((c, i) => {
      const approval = c.needsApproval ? ` [approve ${c.needsApproval.amount} ${c.needsApproval.token}]` : "";
      lines.push(`  ${i + 1}. ${c.target}.${c.fn}${approval}`);
    });
  }

  if (plan.notes.length) {
    lines.push("");
    for (const n of plan.notes) lines.push(`_${n}_`);
  }

  lines.push("");
  lines.push("Confirm to sign within policy, or Cancel.");
  return lines.join("\n");
}
