import type { Address, Hex } from "viem";
import { publicClient } from "../chain/client.js";
import { simulateCall } from "../core/simulator.js";
import { signAndSubmit, PolicyViolationError } from "../custody/signer.js";
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

/**
 * Simulate + sign one step, with retries for FEE steps: the fee is the agent's
 * revenue and its dominant failure mode is a transient Mezo RPC flake, so losing
 * it to one hiccup is pure revenue leakage. Non-fee steps get a single attempt
 * (their failures are surfaced to the user, who can retry the whole action).
 * PolicyViolation is deterministic — never retried.
 */
export async function trySignStep(
  user: UserRecord,
  step: { kind: string; to: Address; data?: Hex; value: bigint; erc20?: { symbol: string; amount: bigint } },
  allowedTargets: Address[],
): Promise<{ ok: true; hash: Hex } | { ok: false; reason: string }> {
  const attempts = step.kind === "fee" ? 3 : 1;
  let lastReason = "unknown error";
  for (let n = 0; n < attempts; n++) {
    if (n > 0) await new Promise((r) => setTimeout(r, 1500));
    const sim = await simulateCall({ from: user.address, to: step.to, data: step.data, value: step.value });
    if (!sim.ok) { lastReason = sim.reason; continue; }
    try {
      const hash = await signAndSubmit(user, {
        to: step.to,
        data: step.data,
        value: step.value,
        policy: { allowedTargets, ...(step.erc20 ? { erc20: step.erc20 } : {}) },
      });
      return { ok: true, hash };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : "signing failed";
      if (err instanceof PolicyViolationError) break;
    }
  }
  return { ok: false, reason: lastReason };
}

/** Persist an uncollected fee so a failed fee-tx is logged revenue, not lost. */
export function recordFeeLoss(user: UserRecord, step: { value: bigint; erc20?: { symbol: string; amount: bigint } }, context: string, reason: string): void {
  store.recordOwedFee({
    telegramId: user.telegramId,
    symbol: step.erc20?.symbol ?? "BTC",
    amountRaw: (step.erc20?.amount ?? step.value).toString(),
    context,
    reason,
    at: new Date().toISOString(),
  });
}

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
    // Simulate-then-sign, with retries + owed-fee logging for fee steps (revenue
    // must survive a transient RPC flake, and a lost fee must be recorded).
    const attempt = await trySignStep(user, step, plan.allowedTargets);
    if (!attempt.ok) {
      if (step.kind === "fee") recordFeeLoss(user, step, plan.action, attempt.reason);
      outcomes.push({ kind: step.kind, ok: false, reason: attempt.reason });
      return { outcomes, aborted: true };
    }
    const hash: Hex = attempt.hash;

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

    // 3. Wait for confirmation when a later step depends on this one. BOUNDED —
    // grammY dispatches updates sequentially, so an unbounded wait on a stuck tx
    // would freeze the whole bot (including /pause). A timeout lets the handler
    // return and the bot stay responsive; the user can retry. (Audit R2 H2.)
    if (step.waitForReceipt) {
      let receipt;
      try {
        receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 6 });
      } catch {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} not confirmed within 90s (tx ${hash}); stopping. It may still land — check before retrying.` });
        return { outcomes, aborted: true };
      }
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
