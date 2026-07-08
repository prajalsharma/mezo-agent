import { formatUnits, type Address } from "viem";
import { publicClient } from "../chain/client.js";
import { erc20Abi } from "../abis/erc20.js";
import { registry } from "../registry/registry.js";
import type { TokenInfo } from "../registry/addresses.js";

export type Holding = {
  token: TokenInfo;
  raw: bigint;
  formatted: string;
};

/**
 * Read the balances of every registered token for an address. This is the read
 * path — fully separate from the write/signing path. Errors on individual tokens
 * are contained so one bad RPC read never blanks the whole portfolio.
 */
export async function getPortfolio(address: Address): Promise<Holding[]> {
  const client = publicClient();
  const tokens = registry.allTokens();

  const holdings = await Promise.all(
    tokens.map(async (token): Promise<Holding> => {
      try {
        const raw = token.native
          ? await client.getBalance({ address })
          : ((await client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            })) as bigint);
        return { token, raw, formatted: formatUnits(raw, token.decimals) };
      } catch {
        return { token, raw: 0n, formatted: "—" };
      }
    }),
  );

  return holdings;
}

/** Trim trailing zeros for display, keeping up to `maxDp` decimal places. */
export function prettyAmount(formatted: string, maxDp = 6): string {
  if (formatted === "—") return formatted;
  const [intPart, decPart = ""] = formatted.split(".");
  const trimmed = decPart.slice(0, maxDp).replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart!;
}
