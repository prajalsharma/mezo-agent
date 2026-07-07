import type { CallPlan } from "./builder.js";

/**
 * Simulator (README §1 rule 3, §5 step 4).
 *
 * "Simulate before sign." Each step of a plan is dry-run (`eth_call` with state
 * overrides, or a hosted simulation provider) and decoded into human-readable
 * effects: new ICR, expected LP out, min received, resulting lock end, fees.
 *
 * The chain call is stubbed here (no live Matsnet connection in the skeleton),
 * but the decode step is real and drives the confirmation the user sees. Wire
 * the RPC in `runEthCall` when addresses/ABIs land (README §12).
 */

export interface DecodedEffect {
  label: string;
  value: string;
  /** Optional risk flag surfaced prominently in the confirmation. */
  warn?: boolean;
}

export interface SimulationResult {
  ok: boolean;
  effects: DecodedEffect[];
  /** Estimated gas denominated in BTC (Mezo's native gas asset). */
  estGasBTC: number;
  error?: string;
}

const MCR = 1.1; // 110% minimum collateral ratio (README §2).

export async function simulate(plan: CallPlan): Promise<SimulationResult> {
  // Placeholder for: `eth_call` per step with state overrides / sim provider.
  // await runEthCall(step) ...
  const effects: DecodedEffect[] = [];

  switch (plan.action) {
    case "borrow": {
      const call = plan.calls[0];
      const collateral = Number(call.args.collateralBTC);
      const debt = Number(call.args.mintMUSD);
      // Illustrative BTC price for decoding; real value comes from PriceFeed.
      const btcPriceMUSD = 65_000;
      const icr = (collateral * btcPriceMUSD) / debt;
      effects.push({ label: "Collateral", value: `${collateral} BTC` });
      effects.push({ label: "Mint", value: `${debt} MUSD` });
      effects.push({
        label: "New collateral ratio (ICR)",
        value: `${(icr * 100).toFixed(0)}%`,
        warn: icr < MCR * 1.2, // warn when within 20% of MCR
      });
      effects.push({ label: "Borrowing fee (est.)", value: `~${(debt * 0.01).toFixed(2)} MUSD (from 1%)` });
      break;
    }
    case "repay": {
      effects.push({ label: "Repay", value: `${plan.calls[0].args.repayMUSD} MUSD` });
      break;
    }
    case "swap": {
      const c = plan.calls[plan.calls.length - 1];
      effects.push({ label: "Swap", value: `${c.args.inputAmount} ${c.args.inputToken} → ${c.args.outputToken}` });
      effects.push({ label: "Min received", value: String(c.args.minOut) });
      effects.push({ label: "Deadline", value: String(c.args.deadline) });
      break;
    }
    case "zap": {
      effects.push({ label: "Zap steps", value: `${plan.calls.length} calls (swap × 2, addLiquidity${plan.calls.length > 3 ? ", stake" : ""})` });
      effects.push({ label: "Expected LP out", value: "<decoded from addLiquidity return>" });
      break;
    }
    case "lock": {
      const c = plan.calls[0];
      const days = Number(c.args.lockDays);
      const end = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      effects.push({ label: "Lock", value: `${c.args.amount} (${days} days)` });
      effects.push({ label: "Lock end", value: end });
      break;
    }
    case "vote": {
      effects.push({ label: "Vote mode", value: String(plan.calls[0].args.mode) });
      effects.push({ label: "Weights", value: JSON.stringify(plan.calls[0].args.weights) });
      break;
    }
    case "claim": {
      effects.push({ label: "Claim", value: `scope=${plan.calls[0].args.scope}` });
      effects.push({ label: "Reward tokens", value: "<enumerated from indexer: BTC + ERC-20s>" });
      break;
    }
    case "portfolio":
      break;
  }

  return { ok: true, effects, estGasBTC: 0.00002 };
}
