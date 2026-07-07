import { createReasoningAdapter, type ReasoningAdapter } from "../reasoning/llmAdapter.js";
import { validateIntent } from "./validator.js";
import { checkPolicy } from "./policy.js";
import { buildPlan, BuildError, type CallPlan } from "./builder.js";
import { simulate, type SimulationResult } from "./simulator.js";
import { formatConfirmation } from "./formatter.js";
import type { Intent } from "../intents/schema.js";

/**
 * Orchestrates the intent → transaction pipeline up to (but not including) the
 * sign step (README §5 steps 1–5). Signing happens only after explicit user
 * confirmation, via the Signer, so it lives in the gateway.
 */

export type PipelineOutcome =
  | { kind: "clarify"; message: string }
  | { kind: "unsupported"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "read"; message: string }
  | { kind: "confirm"; intent: Intent; plan: CallPlan; sim: SimulationResult; summary: string };

export class Pipeline {
  private readonly reasoning: ReasoningAdapter;

  constructor(reasoning: ReasoningAdapter = createReasoningAdapter()) {
    this.reasoning = reasoning;
  }

  async handle(userId: string, message: string): Promise<PipelineOutcome> {
    // 1. Parse (LLM proposes a typed intent, never calldata).
    const parsed = await this.reasoning.parseIntent(message);
    if (parsed.kind === "clarify") return { kind: "clarify", message: parsed.question };
    if (parsed.kind === "unsupported") return { kind: "unsupported", message: parsed.reason };

    // 2. Validate & disambiguate (deterministic, registry-backed).
    const validated = validateIntent(parsed.intent);
    if (!validated.ok) return { kind: "clarify", message: validated.clarify };
    const intent = validated.intent;

    // Read-only path skips policy/build/sign entirely.
    if (intent.action === "portfolio") {
      return { kind: "read", message: renderPortfolio() };
    }

    // 3. Policy gate (defense-in-depth layer 1).
    const policy = checkPolicy(userId, intent);
    if (!policy.allowed) return { kind: "blocked", message: policy.reason ?? "Blocked by policy." };

    // 4. Build → 5. Simulate → format confirmation.
    let plan: CallPlan;
    try {
      plan = buildPlan(intent);
    } catch (e) {
      const msg = e instanceof BuildError ? e.message : "Failed to build transaction plan.";
      return { kind: "unsupported", message: msg };
    }
    const sim = await simulate(plan);
    if (!sim.ok) return { kind: "unsupported", message: sim.error ?? "Simulation failed." };

    return { kind: "confirm", intent, plan, sim, summary: formatConfirmation(plan, sim) };
  }
}

function renderPortfolio(): string {
  // Read path is separate from the write path (README §3 indexer). Stubbed view.
  return [
    "*📊 Portfolio* (read-only, via indexer)",
    "",
    "• BTC (native): _connect RPC/indexer to populate_",
    "• Troves: _health, ICR, liquidation price_",
    "• LP positions & staked gauges",
    "• veBTC / veMEZO locks (amount, end, voting weight)",
    "• Claimable rewards (BTC + ERC-20s)",
    "",
    "_Wire the indexer (README §12 item 3) for live values._",
  ].join("\n");
}
