import type { Hex } from "viem";
import { publicClient } from "../../chain/client.js";
import { simulateCall } from "../../core/simulator.js";
import { signAndSubmit } from "../../custody/signer.js";
import { store, type UserRecord } from "../../db/store.js";
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
        policy: { allowedTargets: [plan.router, plan.tokenIn.address] },
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

    // 3. Wait for the approval to mine before the swap depends on it.
    if (step.kind === "approval") {
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      store.updateTxByHash(hash, receipt.status === "success" ? "confirmed" : "failed");
      if (receipt.status !== "success") {
        outcomes.push({ kind: "approval", ok: false, reason: "approval transaction failed" });
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
