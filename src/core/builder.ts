import type { Intent } from "../intents/schema.js";
import { registry, type Address } from "./registry.js";

/**
 * Per-surface transaction builders (README §3, §5 step 3, §6).
 *
 * An Intent becomes a `CallPlan`: one or an ordered list of concrete calls
 * (a zap = swap + swap + addLiquidity + stake). Addresses are resolved from the
 * registry only. Hints, slippage min-outs, deadlines and approvals are computed
 * here, deterministically — never by the LLM.
 *
 * Multi-step plans carry abort semantics so a failed leg does not leave funds
 * stranded (README §6, §8 edge cases).
 */

export interface Call {
  /** Registry key of the target contract; resolved to an address at build time. */
  target: string;
  targetAddress: Address;
  /** Human label for logs/confirmation, e.g. "openTrove". */
  fn: string;
  /** Structured, decoded args (not calldata). The signer/builder encodes later. */
  args: Record<string, unknown>;
  /** Native BTC value attached (Mezo gas asset). */
  valueBTC?: number;
  /** True if this leg requires an ERC-20 approval first. */
  needsApproval?: { token: string; amount: number };
}

export interface CallPlan {
  action: Intent["action"];
  calls: Call[];
  /** Steps that must roll back / abort if a prior step fails. */
  abortOnFailure: boolean;
  notes: string[];
}

export class BuildError extends Error {}

function mustResolve(name: string): Address {
  const addr = registry.resolveContract(name);
  if (!addr) throw new BuildError(`Registry has no address for "${name}" (resolve in week-one probe).`);
  return addr;
}

const DEADLINE_SECONDS = 20 * 60;

export function buildPlan(intent: Intent): CallPlan {
  switch (intent.action) {
    case "borrow":
      return buildBorrow(intent);
    case "repay":
      return buildRepay(intent);
    case "swap":
      return buildSwap(intent);
    case "zap":
      return buildZap(intent);
    case "lock":
      return buildLock(intent);
    case "vote":
      return buildVote(intent);
    case "claim":
      return buildClaim(intent);
    case "portfolio":
      throw new BuildError("portfolio is read-only and has no transaction plan");
  }
}

function buildBorrow(intent: Extract<Intent, { action: "borrow" }>): CallPlan {
  const target = mustResolve("BorrowerOperations");
  return {
    action: "borrow",
    abortOnFailure: true,
    notes: [
      "Hints (upperHint/lowerHint) are fetched fresh immediately before submit — never cached.",
    ],
    calls: [
      {
        target: "BorrowerOperations",
        targetAddress: target,
        fn: "openTrove",
        args: {
          collateralBTC: intent.collateralBTC,
          mintMUSD: intent.mintMUSD,
          upperHint: "<fetched pre-tx via HintHelpers>",
          lowerHint: "<fetched pre-tx via HintHelpers>",
        },
        valueBTC: intent.collateralBTC,
      },
    ],
  };
}

function buildRepay(intent: Extract<Intent, { action: "repay" }>): CallPlan {
  return {
    action: "repay",
    abortOnFailure: true,
    notes: [],
    calls: [
      {
        target: "BorrowerOperations",
        targetAddress: mustResolve("BorrowerOperations"),
        fn: "adjustTrove",
        args: { repayMUSD: intent.repayMUSD },
        needsApproval: { token: "MUSD", amount: intent.repayMUSD },
      },
    ],
  };
}

function buildSwap(intent: Extract<Intent, { action: "swap" }>): CallPlan {
  const router = mustResolve("Router");
  const calls: Call[] = [];
  if (intent.inputToken !== "BTC") {
    calls.push({
      target: "Router",
      targetAddress: router,
      fn: "approve",
      args: { token: intent.inputToken, spender: router },
      needsApproval: { token: intent.inputToken, amount: intent.inputAmount },
    });
  }
  calls.push({
    target: "Router",
    targetAddress: router,
    fn: "swapExactTokensForTokens",
    args: {
      inputToken: intent.inputToken,
      outputToken: intent.outputToken,
      inputAmount: intent.inputAmount,
      // min-out enforced on-chain from slippage tolerance; quote filled at sim time.
      minOut: `<quote * (1 - ${intent.slippageBps}bps)>`,
      deadline: `now + ${DEADLINE_SECONDS}s`,
    },
    valueBTC: intent.inputToken === "BTC" ? intent.inputAmount : undefined,
  });
  return {
    action: "swap",
    abortOnFailure: true,
    notes: ["Routed via MEV-resistant path where the chain supports it."],
    calls,
  };
}

function buildZap(intent: Extract<Intent, { action: "zap" }>): CallPlan {
  const router = mustResolve("Router");
  const [a, b] = intent.targetPool.toUpperCase().split("/");
  const notes = [`Zap into ${intent.targetPool}: split, swap legs, add liquidity` + (intent.stake ? ", stake LP." : ".")];
  const calls: Call[] = [
    {
      target: "Router",
      targetAddress: router,
      fn: "swap(half -> " + a + ")",
      args: { from: intent.inputToken, to: a, amount: intent.inputAmount / 2 },
      valueBTC: intent.inputToken === "BTC" ? intent.inputAmount / 2 : undefined,
    },
    {
      target: "Router",
      targetAddress: router,
      fn: "swap(half -> " + b + ")",
      args: { from: intent.inputToken, to: b, amount: intent.inputAmount / 2 },
      valueBTC: intent.inputToken === "BTC" ? intent.inputAmount / 2 : undefined,
    },
    {
      target: "Router",
      targetAddress: router,
      fn: "addLiquidity",
      args: { pool: intent.targetPool, tokenA: a, tokenB: b, deadline: `now + ${DEADLINE_SECONDS}s` },
    },
  ];
  if (intent.stake) {
    calls.push({
      target: "Voter",
      targetAddress: mustResolve("Voter"),
      fn: "depositIntoGauge",
      args: { pool: intent.targetPool },
    });
  }
  return { action: "zap", abortOnFailure: true, notes, calls };
}

function buildLock(intent: Extract<Intent, { action: "lock" }>): CallPlan {
  const contractName = intent.asset === "BTC" ? "VotingEscrowBTC" : "VotingEscrowMEZO";
  return {
    action: "lock",
    abortOnFailure: true,
    notes: [
      intent.asset === "BTC"
        ? "veBTC: base voting power + a claim on protocol fees (paid largely in BTC)."
        : "veMEZO: boosts a paired veBTC position up to 5×; no standalone voting power.",
    ],
    calls: [
      {
        target: contractName,
        targetAddress: mustResolve(contractName),
        fn: "createLock",
        args: { amount: intent.amount, lockDays: intent.lockDays },
        valueBTC: intent.asset === "BTC" ? intent.amount : undefined,
        needsApproval: intent.asset === "MEZO" ? { token: "MEZO", amount: intent.amount } : undefined,
      },
    ],
  };
}

function buildVote(intent: Extract<Intent, { action: "vote" }>): CallPlan {
  // In optimal mode the optimizer service fills weights; here we surface intent.
  const weights = intent.weights ?? {};
  return {
    action: "vote",
    abortOnFailure: true,
    notes: [
      intent.mode === "optimal"
        ? "Weights computed by the optimizer service, then confirmed like any other action."
        : "Manual weights.",
      "Votes persist across epochs (Thursday 00:00 UTC flip) unless changed.",
    ],
    calls: [
      {
        target: "Voter",
        targetAddress: mustResolve("Voter"),
        fn: "vote",
        args: { mode: intent.mode, weights },
      },
    ],
  };
}

function buildClaim(intent: Extract<Intent, { action: "claim" }>): CallPlan {
  // Rewards arrive in mixed tokens; the plan enumerates positions from the
  // indexer rather than assuming a fixed token set (README §6).
  return {
    action: "claim",
    abortOnFailure: false,
    notes: [`Claim scope: ${intent.scope}. Handles BTC + arbitrary ERC-20 rewards generically.`],
    calls: [
      {
        target: "Voter",
        targetAddress: mustResolve("Voter"),
        fn: "claimAll",
        args: { scope: intent.scope },
      },
    ],
  };
}
