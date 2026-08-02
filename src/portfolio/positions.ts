import { formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";
import { erc20Abi } from "../abis/erc20.js";
import { gaugeAbi, voterAbi, votingEscrowAbi } from "../abis/mezo.js";
import { readTrove } from "../surfaces/borrow.js";
import { btcPriceUsd } from "../core/prices.js";
import { claimableRebase } from "../core/veEnumeration.js";

/**
 * Live POSITIONS view — the bounty's core requirement: "BTC, MUSD, LP
 * positions, veNFTs, claimable rewards, and open Trove health."
 *
 * Token balances come from portfolioService; this adds everything else, read
 * straight from chain. Every section fails INDEPENDENTLY: one unreachable
 * contract degrades that section only, never blanks the whole view.
 */

export type TroveView = {
  collBTC: number;
  debtMUSD: number;
  /** Collateral ratio in percent, when the price is readable. */
  icrPct?: number;
  /** BTC price at which this Trove becomes liquidatable. */
  liquidationPrice?: number;
};

export type LpView = { pool: string; walletLp: string; stakedLp: string; earned: string };
export type VeView = {
  kind: "veBTC" | "veMEZO";
  id: string;
  /** Undefined when the escrow doesn't expose a readable power function
   *  (veMEZO reverts on balanceOfNFT) — shown as "—" rather than a fake 0. */
  votingPower?: string;
  rebase: string;
  lockedAmount: string;
  /** Unlock date (YYYY-MM-DD) from locked().end. */
  unlocks?: string;
};

export type Positions = {
  trove?: TroveView;
  lps: LpView[];
  veNfts: VeView[];
  veTruncated: boolean;
  /** Sections that could not be read (shown honestly rather than as "none"). */
  unavailable: string[];
};

const MCR = 1.1;

export async function readPositions(owner: Address): Promise<Positions> {
  const out: Positions = { lps: [], veNfts: [], veTruncated: false, unavailable: [] };

  const [trove, price] = await Promise.all([
    readTrove(owner).catch(() => undefined),
    btcPriceUsd().catch(() => undefined),
  ]);

  // ── Trove health ──────────────────────────────────────────────────────────
  if (trove && trove.debtMUSD > 0) {
    const view: TroveView = { collBTC: trove.collBTC, debtMUSD: trove.debtMUSD };
    if (price && trove.collBTC > 0) {
      view.icrPct = ((trove.collBTC * price) / trove.debtMUSD) * 100;
      view.liquidationPrice = (MCR * trove.debtMUSD) / trove.collBTC;
    }
    out.trove = view;
  }

  // ── LP positions (wallet + staked in gauge + claimable) ───────────────────
  const c = publicClient();
  await Promise.all(
    registry.pools().map(async (p) => {
      try {
        const wallet = (await c.readContract({
          address: p.address, abi: erc20Abi, functionName: "balanceOf", args: [owner],
        })) as bigint;
        let staked = 0n;
        let earned = 0n;
        if (registry.hasContract("Voter")) {
          try {
            const gauge = (await c.readContract({
              address: registry.contract("Voter"), abi: voterAbi, functionName: "gauges", args: [p.address],
            })) as Address;
            if (gauge && gauge !== "0x0000000000000000000000000000000000000000") {
              staked = (await c.readContract({ address: gauge, abi: gaugeAbi, functionName: "balanceOf", args: [owner] })) as bigint;
              earned = (await c.readContract({ address: gauge, abi: gaugeAbi, functionName: "earned", args: [owner] })) as bigint;
            }
          } catch { /* no gauge for this pool */ }
        }
        if (wallet > 0n || staked > 0n || earned > 0n) {
          out.lps.push({
            pool: p.pair.join("/"),
            walletLp: trim(formatUnits(wallet, 18)),
            stakedLp: trim(formatUnits(staked, 18)),
            earned: trim(formatUnits(earned, 18)),
          });
        }
      } catch { /* pool unreadable — skip */ }
    }),
  );

  // ── veNFTs — BOTH escrows ─────────────────────────────────────────────────
  // veMEZO was invisible: enumeration was hardcoded to VotingEscrowBTC, so a
  // user who locked MEZO saw "no open positions" despite holding a veMEZO NFT.
  for (const [kind, key] of [["veBTC", "VotingEscrowBTC"], ["veMEZO", "VotingEscrowMEZO"]] as const) {
    if (!registry.hasContract(key)) continue;
    const ve = registry.contract(key);
    try {
      const total = (await c.readContract({
        address: ve, abi: votingEscrowAbi, functionName: "balanceOf", args: [owner],
      })) as bigint;
      const cap = total > 20n ? 20n : total;
      if (total > 20n) out.veTruncated = true;
      for (let idx = 0n; idx < cap; idx++) {
        let id: bigint;
        try {
          id = (await c.readContract({
            address: ve, abi: votingEscrowAbi, functionName: "ownerToNFTokenIdList", args: [owner, idx],
          })) as bigint;
        } catch { break; }
        if (id <= 0n) continue;
        let power: bigint | undefined;
        let locked = 0n;
        let unlocks: string | undefined;
        let rebase = 0n;
        try {
          power = (await c.readContract({
            address: ve, abi: votingEscrowAbi, functionName: "balanceOfNFT", args: [id],
          })) as bigint;
        } catch { /* veMEZO reverts here — leave undefined, never fake a 0 */ }
        try {
          // locked() returns (amount, end) on Velodrome-style escrows; int128
          // amount is common, so decode defensively.
          const l = (await c.readContract({
            address: ve,
            abi: [{ type: "function", name: "locked", stateMutability: "view",
                    inputs: [{ type: "uint256" }],
                    outputs: [{ name: "amount", type: "int128" }, { name: "end", type: "uint256" }] }] as const,
            functionName: "locked", args: [id],
          })) as unknown as readonly [bigint, bigint];
          locked = l[0] > 0n ? l[0] : 0n;
          if (l[1] > 0n) unlocks = new Date(Number(l[1]) * 1000).toISOString().slice(0, 10);
        } catch { /* shape varies across escrows; voting power still shown */ }
        // Rebase is distributed for veBTC via RewardsDistributor.
        if (kind === "veBTC") { try { rebase = await claimableRebase(id); } catch { /* ignore */ } }
        out.veNfts.push({
          kind,
          id: id.toString(),
          ...(power !== undefined ? { votingPower: trim(formatUnits(power, 18)) } : {}),
          rebase: trim(formatUnits(rebase, 18)),
          lockedAmount: trim(formatUnits(locked, 18)),
          ...(unlocks ? { unlocks } : {}),
        });
      }
    } catch {
      out.unavailable.push(kind);
    }
  }

  if (!trove && registry.hasContract("TroveManager")) out.unavailable.push("Trove");
  return out;
}

function trim(v: string): string {
  const n = Number(v);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
