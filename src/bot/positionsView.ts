import type { Address } from "viem";
import { readPositions } from "../portfolio/positions.js";
import { b, i } from "./format.js";

/**
 * Render the live POSITIONS block required by the bounty: open Trove health,
 * LP positions, veNFTs and claimable rewards. Shared by /portfolio and the
 * Portfolio menu card so the two can never drift.
 */
export async function positionsBlock(owner: Address): Promise<string> {
  let p;
  try {
    p = await readPositions(owner);
  } catch {
    return i("(couldn't read positions just now — tap Refresh)");
  }
  const out: string[] = [];

  if (p.trove) {
    const health =
      p.trove.icrPct === undefined
        ? ""
        : ` — ratio ${b(`${p.trove.icrPct.toFixed(0)}%`)} ${p.trove.icrPct >= 150 ? "✅" : p.trove.icrPct >= 110 ? "⚠️" : "🚨"}`;
    out.push(`${b("🏦 Trove")}${health}`);
    out.push(`• Collateral: ${p.trove.collBTC.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} BTC`);
    out.push(`• Debt: ${Math.round(p.trove.debtMUSD).toLocaleString()} MUSD`);
    if (p.trove.liquidationPrice !== undefined) {
      out.push(`• Liquidated if BTC falls below ${b(`$${Math.round(p.trove.liquidationPrice).toLocaleString()}`)}`);
    }
    out.push("");
  }

  if (p.lps.length) {
    out.push(b("🌊 LP positions"));
    for (const l of p.lps) {
      const bits = [`wallet ${l.walletLp}`, `staked ${l.stakedLp}`];
      if (Number(l.earned) > 0) bits.push(`earned ${l.earned}`);
      out.push(`• ${b(l.pool)}: ${bits.join(" · ")}`);
    }
    out.push("");
  }

  if (p.veNfts.length) {
    out.push(b("🔒 veNFTs"));
    for (const v of p.veNfts) {
      const unit = v.kind === "veBTC" ? "BTC" : "MEZO";
      const bits = [`${v.lockedAmount} ${unit} locked`];
      if (v.unlocks) bits.push(`unlocks ${v.unlocks}`);
      if (v.votingPower !== undefined) bits.push(`power ${v.votingPower}`);
      if (Number(v.rebase) > 0) bits.push(`rebase ${v.rebase}`);
      out.push(`• ${b(`${v.kind} #${v.id}`)}: ${bits.join(" · ")}`);
    }
    if (p.veTruncated) out.push(i("(showing the first few — you hold more)"));
    out.push("");
  }

  const claimable =
    p.lps.some((l) => Number(l.earned) > 0) || p.veNfts.some((v) => Number(v.rebase) > 0);
  if (claimable) out.push(i('Rewards waiting — send "claim all" to sweep them.'));

  if (!p.trove && !p.lps.length && !p.veNfts.length) {
    out.push(i("No open positions yet — borrow, zap into a pool, or lock to get started."));
  }
  if (p.unavailable.length) out.push(i(`(couldn't read: ${p.unavailable.join(", ")})`));
  return out.join("\n").trim();
}
