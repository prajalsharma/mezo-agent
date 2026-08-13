import { formatUnits } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";

/**
 * Live USD pricing, shared by borrow (collateral ratios) and the natural-
 * language layer (dollar-denominated intents like "enter the pool with $800").
 * BTC comes from Mezo's own PriceFeed; MUSD and the bridged stables are treated
 * as $1. Anything else is unpriced (return undefined — callers must ask, never
 * guess).
 *
 * `fetchPrice` is the only price selector the deployed PriceFeed actually has,
 * and it REVERTS ("PriceFeed: Oracle is stale.") once the oracle is more than
 * MAX_PRICE_DELAY = 60 seconds old. A revert therefore means "the protocol will
 * refuse this transaction too", not "try again without a ratio check" — see
 * priceOrRefuse() below.
 */
const PRICE_ABI = [
  { type: "function", name: "fetchPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const STABLE_SYMBOLS = new Set(["MUSD", "MUSDC", "MUSDT", "MDAI", "MUSDE"]);

/**
 * Deliberately well inside the protocol's own 60s staleness budget. At 60s the
 * cache could hand back a price the contract would already reject, so every
 * ratio we showed would be computed from a number the protocol disagrees with.
 */
const PRICE_TTL_MS = 15_000;

let btcCache: { at: number; priceWad: bigint } | undefined;

/** Live BTC price in USD from the Mezo PriceFeed. undefined if unreadable/stale. */
export async function btcPriceUsd(): Promise<number | undefined> {
  const wad = await btcPriceWad();
  return wad === undefined ? undefined : Number(formatUnits(wad, 18));
}

/**
 * Same reading, unrounded. The borrow surface does its collateral arithmetic in
 * 1e18 fixed point against the protocol's own 1e18 parameters, so it must not
 * round-trip the price through a float first.
 */
export async function btcPriceWad(): Promise<bigint | undefined> {
  if (btcCache && Date.now() - btcCache.at < PRICE_TTL_MS) return btcCache.priceWad;
  if (!registry.hasContract("PriceFeed")) return undefined;
  try {
    const raw = (await publicClient().readContract({
      address: registry.contract("PriceFeed"),
      abi: PRICE_ABI,
      functionName: "fetchPrice",
    })) as bigint;
    if (raw > 0n) { btcCache = { at: Date.now(), priceWad: raw }; return raw; }
    return undefined;
  } catch {
    // Stale oracle or RPC failure. Both mean "we do not know the price", and
    // the caller must treat that as blocking, not as permission to skip.
    return undefined;
  }
}

/** Test seam - drops the cached price. */
export function resetPriceCache(): void {
  btcCache = undefined;
}

/**
 * Convert a USD amount into a human token amount string for `symbol`.
 * Stables → 1:1; BTC-denominated tokens → via the live feed; otherwise
 * undefined (unpriced — the caller must ask the user rather than guess).
 */
export async function usdToTokenAmount(symbol: string, usd: number): Promise<string | undefined> {
  if (!(usd > 0)) return undefined;
  const s = symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(s)) return trim(usd, 2);
  if (s.includes("BTC")) {
    const p = await btcPriceUsd();
    if (!p) return undefined;
    return trim(usd / p, 8);
  }
  return undefined;
}

function trim(n: number, dp: number): string {
  return n.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
}
