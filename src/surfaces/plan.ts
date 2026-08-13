import type { Address, Hex } from "viem";
import { awaitReceipt, approvalSatisfied, RECEIPT_TIMEOUT_MS } from "../chain/receipt.js";
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

/**
 * What a step does with an asset.
 *
 * Every asset-moving step must carry one of these. The per-transaction cap
 * applies to both kinds — an approval authorises exactly as much as a transfer
 * moves — but only a `spend` is added to the rolling 24h ring, because an
 * approval and the transfer it enables are the SAME funds. Tagging both as
 * spends would double-count a plan; tagging neither is what left the zap's swap
 * and addLiquidity legs invisible to the caps entirely.
 */
export type AssetMove = {
  symbol: string;
  amount: bigint;
  /** Defaults to "spend" — the fail-closed direction for an untagged step. */
  kind?: "spend" | "approval";
};

export type ActionStep = {
  kind: string; // "approval" | "borrow" | "lock" | "fee" | "referral" | ...
  to: Address;
  data?: Hex;
  value: bigint;
  describe: string;
  /** What this step moves, for cap enforcement. REQUIRED on any asset-moving step. */
  erc20?: AssetMove;
  /** Wait for this step to confirm before the next (e.g. approval before spend). */
  waitForReceipt?: boolean;
  /**
   * Re-encode this step's calldata immediately before it is simulated and
   * signed, from live on-chain state.
   *
   * A multi-step plan is built from ONE quote taken before any of it executes,
   * so a later step sized from that quote can be wrong by the time it runs. The
   * zap is the case that bit: its addLiquidity leg asked for the pre-swap quoted
   * amount of the second token while the wallet might hold up to 0.5% less, so
   * the router's transferFrom reverted — after the swap leg had irreversibly
   * settled, leaving the user holding a half-finished zap.
   */
  rebuild?: (owner: Address) => Promise<Hex | undefined>;
};

/** Referral payout carried by a plan, for the earnings ledger. */
export type ReferralPaid = {
  referrerTelegramId: number;
  recipient: Address;
  symbol: string;
  amount: bigint;
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
  /** Set when this plan pays a referrer at source (e.g. atomic zap fee split). */
  referralPaid?: ReferralPaid;
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
  const attempts = step.kind === "fee" || step.kind === "referral" ? 3 : 1;
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

/** Persist an uncollected fee so a failed fee-tx is logged revenue, not lost.
 *  A failed REFERRAL cut is logged under its own beneficiary — it is not
 *  operator revenue and must not inflate the operator's owed-fee report. */
export function recordFeeLoss(user: UserRecord, step: { kind?: string; value: bigint; erc20?: { symbol: string; amount: bigint } }, context: string, reason: string): void {
  store.recordOwedFee({
    telegramId: user.telegramId,
    symbol: step.erc20?.symbol ?? "BTC",
    amountRaw: (step.erc20?.amount ?? step.value).toString(),
    context,
    reason,
    at: new Date().toISOString(),
    beneficiary: step.kind === "referral" ? "referrer" : "operator",
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

  for (const original of plan.steps) {
    // Re-size from live state first, where the step asked for it. This runs
    // BEFORE the simulation, so a step whose sizing has drifted is corrected
    // rather than simulated-then-reverted.
    let step = original;
    if (original.rebuild) {
      try {
        const fresh = await original.rebuild(user.address as Address);
        if (fresh) step = { ...original, data: fresh };
      } catch {
        // Couldn't re-read: fall through with the built calldata. The simulation
        // below is still ahead of the signature, so this fails loudly, not badly.
      }
    }

    // Simulate-then-sign, with retries + owed-fee logging for fee steps (revenue
    // must survive a transient RPC flake, and a lost fee must be recorded).
    const attempt = await trySignStep(user, step, plan.allowedTargets);
    if (!attempt.ok) {
      if (step.kind === "fee" || step.kind === "referral") recordFeeLoss(user, step, plan.action, attempt.reason);
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
      const receipt = await awaitReceipt(hash, { timeoutMs: RECEIPT_TIMEOUT_MS });
      if (!receipt) {
        // An approval's purpose is the allowance, not the receipt: if the
        // allowance is already on-chain the step succeeded and aborting here
        // would strand the user mid-plan (observed live on Mezo, where the
        // receipt watcher stalls on transactions that did confirm).
        if (step.kind === "approval" && (await approvalSatisfied(step.to, step.data, user.address as Address))) {
          store.updateTxByHash(hash, "confirmed");
          await onProgress?.("Approval confirmed (allowance verified on-chain).");
          continue;
        }
        outcomes.push({
          kind: step.kind,
          ok: false,
          reason: `${step.kind} not confirmed within ${RECEIPT_TIMEOUT_MS / 1000}s (tx ${hash}); stopping. It may still land - check before retrying.`,
        });
        return { outcomes, aborted: true };
      }
      store.updateTxByHash(hash, receipt.status === "success" ? "confirmed" : "failed");
      if (receipt.status !== "success") {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} transaction reverted on-chain` });
        return { outcomes, aborted: true };
      }
    } else {
      // Same poller as the blocking path: the watcher stalls on Mezo, which
      // would mark a confirmed transaction "failed" in the user's history.
      void awaitReceipt(hash)
        .then((r) => { if (r) store.updateTxByHash(hash, r.status === "success" ? "confirmed" : "failed"); })
        .catch(() => {});
    }
  }

  const finalHash = [...outcomes].reverse().find((o) => o.ok)?.hash;
  return { outcomes, finalHash, aborted: false };
}
