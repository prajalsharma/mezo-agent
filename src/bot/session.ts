import type { SwapPlan } from "../surfaces/swap/swapBuilder.js";

/**
 * Short-lived, in-memory pending-confirmation state. A built+simulated plan is
 * parked here between the confirmation prompt and the user's Confirm/Cancel tap.
 * Production moves this to Redis (architecture §3); the shape is identical.
 *
 * Plans expire so a stale quote can never be executed at an old price.
 */

type PendingInput =
  | { kind: "swap"; plan: SwapPlan }
  | { kind: "import-await" };

type Pending = PendingInput & { expiresAt: number };

const PENDING_TTL_MS = 3 * 60 * 1000;

const pending = new Map<number, Pending>();

export function setPending(telegramId: number, p: PendingInput): void {
  pending.set(telegramId, { ...p, expiresAt: Date.now() + PENDING_TTL_MS });
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
