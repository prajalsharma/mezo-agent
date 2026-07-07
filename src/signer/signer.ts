import { config } from "../config.js";
import type { Intent } from "../intents/schema.js";
import type { CallPlan } from "../core/builder.js";
import { checkPolicy } from "../core/policy.js";

/**
 * Signer / custody service (README §3, §4).
 *
 * Isolated responsibility: "sign this operation IF it is within policy." In
 * production this is a separate process holding a scoped session key in
 * KMS/enclave/MPC, exposing no key material to the rest of the system.
 *
 * Two properties this skeleton preserves faithfully:
 *  1. The signer RE-CHECKS policy independently (defense-in-depth layer 2) —
 *     it does not trust that the gateway already checked.
 *  2. Secrets never cross the reasoning boundary and are never logged. The key
 *     (if present at all) is only the Tier-3 local-dev fallback; empty key =>
 *     dry-run only.
 */

export interface SignResult {
  submitted: boolean;
  txHash?: `0x${string}`;
  dryRun: boolean;
  reason?: string;
}

export class Signer {
  private readonly hasKey: boolean;

  constructor() {
    // We only record presence — never the value, never a log of it.
    this.hasKey = config.signer.privateKey.trim().length > 0;
  }

  get mode(): "live" | "dry-run" {
    return this.hasKey ? "live" : "dry-run";
  }

  async signAndSubmit(userId: string, intent: Intent, plan: CallPlan): Promise<SignResult> {
    // Layer 2: independent policy re-check at the trust boundary.
    const policy = checkPolicy(userId, intent);
    if (!policy.allowed) {
      return { submitted: false, dryRun: this.mode === "dry-run", reason: policy.reason };
    }

    if (this.mode === "dry-run") {
      return {
        submitted: false,
        dryRun: true,
        reason: "No signer key configured — simulated and confirmed, but not submitted (dry-run).",
      };
    }

    // Live path (Tier-3 local dev). Real implementation:
    //  - fetch fresh hints for borrow plans immediately before submit,
    //  - encode each Call to calldata via the resolved proxy ABI,
    //  - sign within the scoped session policy,
    //  - submit via the account's permissioned execute path (module enforces
    //    scope on-chain — layer 3), monitor, decode reverts.
    void plan;
    return {
      submitted: true,
      dryRun: false,
      txHash: ("0x" + "00".repeat(32)) as `0x${string}`,
      reason: "Submitted (stub hash — wire viem + registry ABIs to go live on Matsnet).",
    };
  }
}

export const signer = new Signer();
