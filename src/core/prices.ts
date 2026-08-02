import { formatUnits } from "viem";
import { publicClient } from "../chain/client.js";
import { registry } from "../registry/registry.js";

/**
 * Live USD pricing, shared by borrow (collateral ratios) and the natural-
 * language layer (dollar-denominated intents like "enter the pool with $800").
 * BTC comes from Mezo's own PriceFeed; MUSD and the bridged stables are treated
 * as $1. Anything else is unpriced (return undefined — callers must ask, never
 * guess). fetchPrice is nonpayable on-chain but readable via eth_call.
 */
const PRICE_ABI = [
  { type: "function", name: "fetchPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const STABLE_SYMBOLS = new Set(["MUSD", "MUSDC", "MUSDT", "MDAI", "MUSDE"]);

let btcCache: { at: number; price: number } | undefined;

/** Live BTC price in USD from the Mezo PriceFeed (60s cache). undefined if unreadable. */
export async function btcPriceUsd(): Promise<number | undefined> {
  if (btcCache && Date.now() - btcCache.at < 60_000) return btcCache.price;
  if (!registry.hasContract("PriceFeed")) return undefined;
  try {
    const raw = (await publicClient().readContract({
      address: registry.contract("PriceFeed"),
      abi: PRICE_ABI,
      functionName: "fetchPrice",
    })) as bigint;
    const price = Number(formatUnits(raw, 18));
    if (price > 0) { btcCache = { at: Date.now(), price }; return price; }
    return undefined;
  } catch {
    return undefined;
  }
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
