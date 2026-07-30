import { formatUnits, type Address, type Hex } from "viem";
import { publicClient } from "../../chain/client.js";
import { erc20Abi } from "../../abis/erc20.js";
import { registry } from "../../registry/registry.js";
import { prettyAmount } from "../../portfolio/portfolioService.js";
import { explorerTxUrl } from "../../chain/networks.js";
import type { NetworkName } from "../../config/env.js";
import { b, esc, link } from "../format.js";

/**
 * Shared transaction-result helpers used by BOTH the swap handler and the
 * generic action handler, so every surface answers "insufficient funds",
 * "success", and "failed" the SAME way. Before this existed each surface rolled
 * its own — a bare "✅ Done." with a link to the wrong tx, and no upfront balance
 * check. (Execution-UX audit.)
 */

/** Minimal shape both SwapPlan and ActionPlan satisfy. */
type PlanLike = {
  nativeValue: bigint;
  steps: { kind: string; erc20?: { symbol: string; amount: bigint } }[];
};

type Outcome = { kind: string; ok: boolean; hash?: Hex };

/**
 * The tx hash of the PRIMARY action (borrow/lock/swap/deposit…), NOT the trailing
 * agent-fee or leading approval. finalHash used to be "last ok step", which for a
 * fee-bearing plan is the tiny fee transfer — so "View on explorer" opened the
 * wrong transaction. This picks the real action step.
 */
export function actionHashOf(outcomes: Outcome[]): Hex | undefined {
  const ok = outcomes.filter((o) => o.ok && o.hash);
  const primary = ok.find((o) => o.kind !== "approval" && o.kind !== "fee");
  return (primary ?? ok[ok.length - 1])?.hash;
}

/** True when the primary action landed even though a later step (e.g. fee) failed. */
export function actionLanded(outcomes: Outcome[]): boolean {
  return outcomes.some((o) => o.ok && o.kind !== "approval" && o.kind !== "fee");
}

/**
 * Pre-flight balance check at PREVIEW time (before the user taps Confirm), so an
 * insufficient balance is caught up front instead of after an approval has
 * already been signed and spent gas. Reads on-chain balances for exactly the
 * tokens the plan spends.
 *
 * Deliberately conservative to avoid false positives that would block a valid
 * action: approval AND fee steps are excluded from the requirement (fees are
 * often taken from proceeds the user only receives mid-plan, e.g. minted MUSD);
 * BTC uses max(nativeValue, taggedBTC) to avoid double-counting; and any RPC
 * read error fails OPEN (returns null = allow). Returns a friendly message when
 * the balance is clearly insufficient, otherwise null.
 */
export async function preflightBalances(owner: Address, plan: PlanLike): Promise<string | null> {
  const need = new Map<string, bigint>();
  let btcTagged = 0n;
  for (const s of plan.steps) {
    if (s.kind === "approval" || s.kind === "fee") continue;
    const e = s.erc20;
    if (!e || e.amount <= 0n) continue;
    if (e.symbol.toUpperCase() === "BTC") btcTagged += e.amount;
    else need.set(e.symbol, (need.get(e.symbol) ?? 0n) + e.amount);
  }
  const btcNeed = plan.nativeValue > btcTagged ? plan.nativeValue : btcTagged;
  if (btcNeed > 0n) need.set("BTC", btcNeed);

  const client = publicClient();
  for (const [sym, amount] of need) {
    const tok = registry.tryToken(sym);
    if (!tok) continue;
    let bal: bigint;
    try {
      bal = tok.native
        ? await client.getBalance({ address: owner })
        : ((await client.readContract({
            address: tok.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          })) as bigint);
    } catch {
      continue; // fail open — never block on a read error
    }
    if (bal < amount) {
      const have = prettyAmount(formatUnits(bal, tok.decimals));
      const want = prettyAmount(formatUnits(amount, tok.decimals));
      const gas = tok.native ? " (plus a little extra for gas)" : "";
      return `You don't have enough ${sym}. You have ${have} ${sym} but this needs ${want} ${sym}${gas}. Send /deposit to fund your wallet.`;
    }
  }
  return null;
}

/**
 * Turn a raw revert / signer error into a plain sentence. PolicyViolationError
 * messages ("Blocked: …") are already human — pass them through. Otherwise map
 * the common cryptic viem/EVM phrases; last resort, return the first line only
 * (never the multi-line viem dump).
 */
export function friendlyReason(reason: string): string {
  const r = reason || "unknown error";
  if (/^Blocked:/.test(r)) return r; // policy messages are already friendly
  if (/insufficient funds|exceeds the balance of the account|gas required exceeds/i.test(r))
    return "You don't have enough BTC to cover the amount plus gas. Send /deposit to fund your wallet.";
  if (/transfer amount exceeds balance|exceeds balance|insufficient balance|subtraction overflow/i.test(r))
    return "You don't have enough of that token for this. Check /portfolio.";
  if (/insufficient allowance|exceeds allowance/i.test(r))
    return "Token approval fell short — please try the action again.";
  if (/ICR < MCR|MCR is not permitted|collateral ratio|below the minimum collateral|minimum net debt/i.test(r))
    return "This borrow would be under-collateralized. Add more BTC collateral, or mint less MUSD — your collateral must stay worth at least 110% of the debt.";
  if (/troveManager|BorrowerOps|does not exist|already active/i.test(r))
    return "That Trove operation isn't valid for your current position (e.g. no open Trove, or it already exists). Check /portfolio.";
  if (/not confirmed within|reverted on-chain/i.test(r)) return r; // already clear
  if (/user rejected|denied/i.test(r)) return "Cancelled.";
  if (/missing or invalid parameters|invalid parameters|-32602|underpriced|fee too low/i.test(r))
    return "The network rejected the transaction (often a temporary node hiccup or a fee that's too low). Please try again in a moment.";
  if (/code = unknown|unknown reason|rpc error|execution reverted with reason:\s*\.?\s*$/i.test(r))
    return "The transaction reverted on-chain — this can be a Mezo testnet node hiccup, or the amount being too large for the pool's liquidity. Please try again, or use a smaller amount.";
  return r.split("\n")[0]!.slice(0, 180);
}

/** Success message: what happened + a link to the REAL action tx. */
export function renderSuccess(params: {
  title: string;
  lines: string[];
  hash: Hex;
  network: NetworkName;
  note?: string;
}): string {
  const out = [`✅ ${b(params.title)}`];
  for (const l of params.lines) out.push("• " + esc(l));
  if (params.note) out.push("", "ℹ️ " + esc(params.note));
  out.push("", link("View transaction on explorer", explorerTxUrl(params.network, params.hash)));
  return out.join("\n");
}
