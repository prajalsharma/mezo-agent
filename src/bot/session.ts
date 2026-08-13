import { randomBytes } from "node:crypto";
import type { SwapPlan } from "../surfaces/swap/swapBuilder.js";
import type { ActionPlan } from "../surfaces/plan.js";

/**
 * Short-lived pending-confirmation state. A built+simulated plan is parked here
 * between the confirmation prompt and the user's Confirm/Cancel tap.
 *
 * THE PLAN THE USER APPROVED MUST BE THE PLAN THAT GETS SIGNED.
 *
 * That used to hold by luck rather than by construction. There was one slot per
 * user, overwritten unconditionally, and the confirm buttons were the constant
 * strings "swap:confirm" / "action:confirm" — carrying no identity at all. So:
 *
 *   1. user: "swap 0.001 BTC to MUSD"  → plan A stored, card A rendered
 *   2. anything re-enters (a second message, a suggestion chip, a menu tap)
 *      → plan B overwrites the SAME slot; card A stays on screen, still armed
 *   3. user scrolls up and taps Confirm on card A
 *      → the slot returns plan B, and plan B is what gets signed
 *
 * Now every card carries a single-use random id in its callback data, and
 * `takePending` matches that id against the stored plan and deletes it in the
 * same synchronous step. A superseded card is refused rather than honoured, and
 * two rapid taps cannot both claim one plan (grammY dispatches same-user updates
 * concurrently, so the second tap used to read the plan before the first cleared
 * it and execute it twice).
 *
 * Plans also expire, so a stale quote can never execute at an old price.
 */

type PendingInput =
  | { kind: "swap"; plan: SwapPlan; stepUpPending?: boolean }
  | { kind: "action"; plan: ActionPlan; stepUpPending?: boolean }
  | { kind: "limits-raise"; raise: LimitsRaise }
  | { kind: "import-await" };

/** A pending cap increase. Raising a cap is the one /limits action that enables a drain. */
export type LimitsRaise = { field: string; wei: bigint; token?: string; raw?: bigint };

export type Pending = PendingInput & {
  /** Single-use id echoed in the card's callback data. */
  id: string;
  expiresAt: number;
  /**
   * The account this plan was BUILT for. A user with several accounts can switch
   * the active one between the card being rendered and the Confirm tap, which
   * would sign account 2's key over calldata built for account 1.
   */
  accountAddress?: string;
  /** Where the card lives, so a superseded one can be disarmed. */
  card?: { chatId: number; messageId: number };
};

// Fund-moving plans expire fast so a stale quote can't execute at an old price.
const PENDING_TTL_MS = 3 * 60 * 1000;
// A cap raise is not a quote, but it must not sit armed forever either: an
// abandoned raise could otherwise be applied by any later tap on a stale card.
const RAISE_TTL_MS = 5 * 60 * 1000;
// The import prompt is not a quote — a short TTL just risks the pasted secret
// falling through to the LLM after it lapses. Give it a long window; the message
// handler also has a secret-shaped-text guard on every text-bearing update.
const IMPORT_TTL_MS = 30 * 60 * 1000;

const pending = new Map<number, Pending>();

function ttlFor(kind: PendingInput["kind"]): number {
  if (kind === "import-await") return IMPORT_TTL_MS;
  if (kind === "limits-raise") return RAISE_TTL_MS;
  return PENDING_TTL_MS;
}

/**
 * Called with the card of a plan that has just been superseded, so the UI can
 * strip its keyboard. Registered by the bot; session.ts stays transport-free.
 */
type SupersedeHook = (card: { chatId: number; messageId: number }) => void;
let onSupersede: SupersedeHook | undefined;
export function setSupersedeHook(fn: SupersedeHook): void {
  onSupersede = fn;
}

/**
 * Park a plan and return the id its confirm button must carry. Any plan already
 * pending for this user is superseded — and its card disarmed, so there is no
 * live button on screen that no longer corresponds to anything.
 */
export function setPending(telegramId: number, p: PendingInput, accountAddress?: string): string {
  const previous = pending.get(telegramId);
  if (previous?.card && onSupersede) {
    try { onSupersede(previous.card); } catch { /* best effort */ }
  }
  const id = randomBytes(9).toString("base64url");
  pending.set(telegramId, { ...p, id, expiresAt: Date.now() + ttlFor(p.kind), accountAddress });
  return id;
}

/** Record which message carries this plan's buttons, so it can be disarmed later. */
export function attachCard(telegramId: number, id: string, chatId: number, messageId: number): void {
  const p = pending.get(telegramId);
  if (p && p.id === id) p.card = { chatId, messageId };
}

/**
 * Peek without consuming. Only for paths with no button identity to check
 * (the import flow, which is consumed by the next text message).
 */
export function getPending(telegramId: number): Pending | undefined {
  const p = pending.get(telegramId);
  if (!p) return undefined;
  if (Date.now() > p.expiresAt) {
    pending.delete(telegramId);
    return undefined;
  }
  return p;
}

export type TakeResult =
  | { ok: true; pending: Pending }
  | { ok: false; why: "none" | "expired" | "superseded" };

/**
 * Claim the pending plan for `id`, deleting it in the SAME synchronous step.
 *
 * Nothing may be awaited between the match and the delete — that gap is what let
 * two rapid confirm taps both read the plan and execute it twice against one
 * confirmation. Callers must therefore call this BEFORE `answerCallbackQuery`.
 */
export function takePending(telegramId: number, id: string): TakeResult {
  const p = pending.get(telegramId);
  if (!p) return { ok: false, why: "none" };
  if (Date.now() > p.expiresAt) {
    pending.delete(telegramId);
    return { ok: false, why: "expired" };
  }
  // The tapped card names a plan that is no longer the pending one: the user
  // asked for something else in between. Refuse rather than sign the newer plan.
  if (p.id !== id) return { ok: false, why: "superseded" };
  pending.delete(telegramId);
  return { ok: true, pending: p };
}

/** Re-park a plan under a NEW id (step-up confirmation), returning that id. */
export function repark(telegramId: number, p: PendingInput, accountAddress?: string): string {
  return setPending(telegramId, p, accountAddress);
}

export function clearPending(telegramId: number): void {
  pending.delete(telegramId);
}

/** Human explanation for a refused confirm tap. */
export function refusalText(why: "none" | "expired" | "superseded"): string {
  if (why === "superseded") {
    return (
      "That preview was replaced by a newer one, so I didn't execute it. " +
      "Scroll down to the most recent card and confirm there, or ask again."
    );
  }
  if (why === "expired") return "That preview expired (quotes are only held for 3 minutes). Please ask again.";
  return "There's nothing pending to confirm. Please ask again.";
}
