import type { Address } from "viem";
import type { Intent } from "../llm/intent.js";
import { type ActionPlan, ActionUnavailableError } from "./plan.js";
import { buildBorrow, buildRepay, buildAdjust, buildCloseTrove } from "./borrow.js";
import { buildStakeLp, buildUnstakeLp, buildVaultDeposit, buildClaim } from "./earn.js";
import { buildLock, buildExtendLock } from "./lock.js";
import { buildVote } from "./vote.js";
import { buildZap } from "./zap.js";
import { buildMarketBrowse, buildMarketBuy, buildMatchbox, buildVeTransfer, buildVeMerge } from "./misc.js";

/**
 * Maps a validated intent to an ActionPlan. Only fund-moving / preview surfaces
 * live here; read-only (portfolio), swap (its own live-quote handler), and
 * meta actions (account, dca, autoCompound, clarify) are handled in the gateway.
 *
 * Returns undefined for intents this dispatcher doesn't own, so the gateway can
 * route them elsewhere.
 */
export async function buildActionPlan(intent: Intent, owner: Address): Promise<ActionPlan | undefined> {
  switch (intent.action) {
    case "borrow": return buildBorrow(intent);
    case "repay": return buildRepay(intent);
    case "adjust": return buildAdjust(intent);
    case "closeTrove": return buildCloseTrove();
    case "vaultDeposit": return buildVaultDeposit(intent, owner);
    case "stakeLp": return buildStakeLp(intent, owner);
    case "unstakeLp": return buildUnstakeLp(intent, owner);
    case "claim": return buildClaim(intent, owner);
    case "lock": return buildLock(intent);
    case "extendLock": return buildExtendLock(intent);
    case "vote": return buildVote(intent);
    case "zap": return buildZap(intent, owner);
    case "matchbox": return buildMatchbox(intent);
    case "marketBrowse": return buildMarketBrowse(intent.query);
    case "marketBuy": return buildMarketBuy(intent);
    case "veTransfer": return buildVeTransfer(intent, owner);
    case "veMerge": return buildVeMerge(intent);
    default: return undefined;
  }
}

export { ActionUnavailableError };
export type { ActionPlan };
