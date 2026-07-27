import type { Address, Hex } from "viem";
import { publicClient } from "../chain/client.js";
import { simulateCall } from "../core/simulator.js";
import { signAndSubmit } from "../custody/signer.js";
import { store, type UserRecord } from "../db/store.js";

/**
 * Unified action framework. Every fund-moving surface (borrow, lock, vote, zap,
 * …) compiles a natural-language intent into an ActionPlan: an ordered list of
 * encoded steps plus a human-readable summary. One executor drives them all
 * through the same "simulate → sign-within-policy → record" path, so the safety
 * guarantees are identical everywhere and defined once.
 *
 * Addresses always come from the registry. When a required address isn't yet
 * published, the builder returns a GATED plan (executable=false) that still
 * shows the human summary but refuses to sign — never an invented address.
 */

export type ActionStep = {
  kind: string; // "approval" | "borrow" | "lock" | ...
  to: Address;
  data?: Hex;
  value: bigint;
  describe: string;
  /** ERC-20 amount this step moves, for per-token cap enforcement (optional). */
  erc20?: { symbol: string; amount: bigint };
  /** Wait for this step to confirm before the next (e.g. approval before spend). */
  waitForReceipt?: boolean;
};

export type ActionPlan = {
  action: string;
  title: string; // e.g. "🏦 Borrow MUSD"
  summary: string[]; // human-readable effect lines (already HTML-escaped-safe text)
  warnings: string[]; // risk lines surfaced prominently (e.g. liquidation risk)
  steps: ActionStep[];
  /** Contracts the signer is allowed to touch for this plan. */
  allowedTargets: Address[];
  executable: boolean;
  gatedReason?: string;
  /** Native BTC value the whole plan moves (for step-up / display). */
  nativeValue: bigint;
};

export class ActionUnavailableError extends Error {}

/** Build a gated (quote/preview-only) plan that shows a summary but can't sign. */
export function gatedPlan(params: {
  action: string;
  title: string;
  summary: string[];
  warnings?: string[];
  reason: string;
}): ActionPlan {
  return {
    action: params.action,
    title: params.title,
    summary: params.summary,
    warnings: params.warnings ?? [],
    steps: [],
    allowedTargets: [],
    executable: false,
    gatedReason: params.reason,
    nativeValue: 0n,
  };
}

export type StepOutcome =
  | { kind: string; ok: true; hash: Hex }
  | { kind: string; ok: false; reason: string };

export type ActionExecution = {
  outcomes: StepOutcome[];
  finalHash?: Hex;
  aborted: boolean;
};

/**
 * Execute an ActionPlan: simulate each step immediately before signing, sign
 * within policy (signer re-checks caps/allowlist), record it, and — for steps
 * a later step depends on — wait for the receipt before continuing. A revert or
 * policy rejection at any step aborts with a decoded reason.
 */
export async function executeActionPlan(
  user: UserRecord,
  plan: ActionPlan,
  onProgress?: (msg: string) => Promise<void>,
): Promise<ActionExecution> {
  const outcomes: StepOutcome[] = [];

  if (!plan.executable || plan.steps.length === 0) {
    return {
      outcomes: [{ kind: plan.action, ok: false, reason: plan.gatedReason ?? "This action isn't executable on the current deployment." }],
      aborted: true,
    };
  }

  for (const step of plan.steps) {
    // 1. Simulate immediately before signing this exact step.
    const sim = await simulateCall({ from: user.address, to: step.to, data: step.data, value: step.value });
    if (!sim.ok) {
      outcomes.push({ kind: step.kind, ok: false, reason: sim.reason });
      return { outcomes, aborted: true };
    }

    // 2. Sign & submit within policy — signer only allowed to touch these targets.
    let hash: Hex;
    try {
      hash = await signAndSubmit(user, {
        to: step.to,
        data: step.data,
        value: step.value,
        policy: { allowedTargets: plan.allowedTargets, ...(step.erc20 ? { erc20: step.erc20 } : {}) },
      });
    } catch (err) {
      outcomes.push({ kind: step.kind, ok: false, reason: err instanceof Error ? err.message : "signing failed" });
      return { outcomes, aborted: true };
    }

    outcomes.push({ kind: step.kind, ok: true, hash });
    store.addTx({
      telegramId: user.telegramId,
      kind: `${plan.action}:${step.kind}`,
      summary: step.describe,
      hash,
      status: "submitted",
      at: new Date().toISOString(),
    });
    await onProgress?.(`Submitted ${step.kind}: ${hash}`);

    // 3. Wait for confirmation when a later step depends on this one.
    if (step.waitForReceipt) {
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      store.updateTxByHash(hash, receipt.status === "success" ? "confirmed" : "failed");
      if (receipt.status !== "success") {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} transaction reverted on-chain` });
        return { outcomes, aborted: true };
      }
    } else {
      void publicClient()
        .waitForTransactionReceipt({ hash })
        .then((r) => store.updateTxByHash(hash, r.status === "success" ? "confirmed" : "failed"))
        .catch(() => store.updateTxByHash(hash, "failed"));
    }
  }

  const finalHash = [...outcomes].reverse().find((o) => o.ok)?.hash;
  return { outcomes, finalHash, aborted: false };
}
