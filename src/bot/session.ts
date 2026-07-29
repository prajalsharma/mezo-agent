import type { SwapPlan } from "../surfaces/swap/swapBuilder.js";
import type { ActionPlan } from "../surfaces/plan.js";

/**
 * Short-lived, in-memory pending-confirmation state. A built+simulated plan is
 * parked here between the confirmation prompt and the user's Confirm/Cancel tap.
 * Production moves this to Redis (architecture §3); the shape is identical.
 *
 * Plans expire so a stale quote can never be executed at an old price.
 */

type PendingInput =
  | { kind: "swap"; plan: SwapPlan; stepUpPending?: boolean }
  | { kind: "action"; plan: ActionPlan; stepUpPending?: boolean }
  | { kind: "import-await" };

type Pending = PendingInput & { expiresAt: number };

// Fund-moving plans expire fast so a stale quote can't execute at an old price.
const PENDING_TTL_MS = 3 * 60 * 1000;
// The import prompt is not a quote — a short TTL just risks the pasted secret
// falling through to the LLM after it lapses (Audit R2 C3). Give it a long
// window; the message handler also has an unconditional secret-shaped-text guard.
const IMPORT_TTL_MS = 30 * 60 * 1000;

const pending = new Map<number, Pending>();

export function setPending(telegramId: number, p: PendingInput): void {
  const ttl = p.kind === "import-await" ? IMPORT_TTL_MS : PENDING_TTL_MS;
  pending.set(telegramId, { ...p, expiresAt: Date.now() + ttl });
}

export function getPending(telegramId: number): Pending | undefined {
  const p = pending.get(telegramId);
  if (!p) return undefined;
  if (Date.now() > p.expiresAt) {
    pending.delete(telegramId);
    return undefined;
  }
  return p;
}

export function clearPending(telegramId: number): void {
  pending.delete(telegramId);
}
