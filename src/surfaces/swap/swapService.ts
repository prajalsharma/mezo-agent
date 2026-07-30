import type { Hex } from "viem";
import { publicClient } from "../../chain/client.js";
import { trySignStep, recordFeeLoss } from "../plan.js";
import { store, type UserRecord } from "../../db/store.js";
import { registry } from "../../registry/registry.js";
import type { PlanStep, SwapPlan } from "./swapBuilder.js";

/**
 * SwapService — orchestrates execution of a confirmed SwapPlan.
 *
 * "Simulate before sign" is enforced per step, immediately before signing: an
 * approval is dry-run then signed and mined; only then is the swap re-simulated
 * (now that the allowance exists) and signed. A revert at any step aborts the
 * flow with a decoded reason rather than pushing a doomed transaction.
 */

export type StepOutcome =
  | { kind: PlanStep["kind"]; ok: true; hash: Hex }
  | { kind: PlanStep["kind"]; ok: false; reason: string };

export type SwapExecution = {
  outcomes: StepOutcome[];
  finalHash?: Hex;
  aborted: boolean;
};

export async function executeSwap(
  user: UserRecord,
  plan: SwapPlan,
  onProgress?: (msg: string) => Promise<void>,
): Promise<SwapExecution> {
  const outcomes: StepOutcome[] = [];

  // Defensive: only an executable plan (Router confirmed) reaches here.
  if (!plan.executable || !plan.router || plan.steps.length === 0) {
    return {
      outcomes: [{ kind: "swap", ok: false, reason: plan.gatedReason ?? "This swap is quote-only; execution is not enabled." }],
      aborted: true,
    };
  }
  // Allowlist from the addresses the plan actually calls: the router, the
  // ROUTING address of the input (the BTC precompile for native, not the 0x000…0
  // sentinel), and the fee recipient when a fee step exists. Building it from
  // tokenIn.address made native swaps unsignable — the steps target 0x7b7C…0000
  // but the allowlist held 0x000…0. (Audit R2 H1.)
  const allowedTargets = [
    plan.router,
    registry.routingAddress(plan.tokenIn),
    ...(plan.fee ? [plan.fee.recipient] : []),
    // Native-BTC referral reward transfers directly to the referrer's wallet.
    ...(plan.referralPaid ? [plan.referralPaid.recipient] : []),
  ];

  for (const step of plan.steps) {
    // Simulate-then-sign with retries for fee steps (revenue survives transient
    // RPC flakes; a lost fee is recorded as owed). Cap metadata travels ON the
    // step, so native BTC is capped via btcWeiMoved and tokens via the per-token
    // cap. (Audit R2 C1/H1.)
    const attempt = await trySignStep(user, step, allowedTargets);
    if (!attempt.ok) {
      if (step.kind === "fee") {
        recordFeeLoss(user, step, `swap ${plan.tokenIn.symbol}→${plan.tokenOut.symbol}`, attempt.reason);
      }
      outcomes.push({ kind: step.kind, ok: false, reason: attempt.reason });
      return { outcomes, aborted: true };
    }
    const hash: Hex = attempt.hash;

    outcomes.push({ kind: step.kind, ok: true, hash });
    store.addTx({
      telegramId: user.telegramId,
      kind: `swap:${step.kind}`,
      summary: step.describe,
      hash,
      status: "submitted",
      at: new Date().toISOString(),
    });
    await onProgress?.(`Submitted ${step.kind}: ${hash}`);

    // 3. Wait for the receipt when a later step depends on this one: the
    //    approval grants the allowance the swap needs, and the swap must CONFIRM
    //    before the fee is charged (Audit R3 F1 — no fee on a failed swap). A
    //    bounded timeout keeps the single-threaded bot responsive (Audit R2 H2).
    if (step.kind === "approval" || step.kind === "fee" || step.waitForReceipt) {
      let receipt;
      try {
        receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 6 });
      } catch {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} not confirmed within 90s (tx ${hash}); stopping.` });
        return { outcomes, aborted: true };
      }
      store.updateTxByHash(hash, receipt.status === "success" ? "confirmed" : "failed");
      if (receipt.status !== "success") {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} transaction reverted on-chain` });
        return { outcomes, aborted: true };
      }
    } else {
      // Track the swap's confirmation without blocking the reply.
      void publicClient()
        .waitForTransactionReceipt({ hash })
        .then((r) => store.updateTxByHash(hash, r.status === "success" ? "confirmed" : "failed"))
        .catch(() => store.updateTxByHash(hash, "failed"));
    }
  }

  const finalHash = [...outcomes].reverse().find((o) => o.ok)?.hash;
  return { outcomes, finalHash, aborted: false };
}
