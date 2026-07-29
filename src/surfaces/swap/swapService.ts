import type { Hex } from "viem";
import { publicClient } from "../../chain/client.js";
import { simulateCall } from "../../core/simulator.js";
import { signAndSubmit } from "../../custody/signer.js";
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
  ];

  for (const step of plan.steps) {
    // 1. Simulate immediately before signing this exact step.
    const sim = await simulateCall({
      from: user.address,
      to: step.to,
      data: step.data,
      value: step.value,
    });
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
        // Cap metadata now travels ON the step (set by the builder), so native
        // BTC is capped via the signer's btcWeiMoved and tokens via the per-token
        // cap — the previous `!native` guard here inverted reality and exempted
        // native BTC from all caps. (Audit R2 C1/H1.)
        policy: { allowedTargets, ...(step.erc20 ? { erc20: step.erc20 } : {}) },
      });
    } catch (err) {
      outcomes.push({
        kind: step.kind,
        ok: false,
        reason: err instanceof Error ? err.message : "signing failed",
      });
      return { outcomes, aborted: true };
    }

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

    // 3. Wait for steps the swap depends on (fee reduces the balance, approval
    //    grants the allowance) before continuing.
    if (step.kind === "approval" || step.kind === "fee") {
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      store.updateTxByHash(hash, receipt.status === "success" ? "confirmed" : "failed");
      if (receipt.status !== "success") {
        outcomes.push({ kind: step.kind, ok: false, reason: `${step.kind} transaction failed` });
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
