import { config } from "../config.js";

/**
 * Contract & token registry (README §1 rule 4, §3).
 *
 * Single source of truth for addresses. Addresses come from here, NEVER from
 * the LLM and NEVER hardcoded at call sites. In production this fetches and
 * caches the canonical Mezo contracts reference (versioned, with change
 * detection). Here it is seeded with the known Matsnet placeholders; unknown
 * entries resolve to `undefined` so the builder fails loudly rather than
 * inventing an address.
 *
 * All Mezo contracts are proxies — we store the proxy address and resolve the
 * implementation ABI separately (README §2).
 */

export type Address = `0x${string}`;

export interface TokenInfo {
  symbol: string;
  address: Address | "native";
  decimals: number;
}

// Placeholder addresses. Replace with canonical values from the contracts
// reference during the week-one probe (README §12 item 2). Kept obviously-fake
// so nobody mistakes them for production addresses.
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

interface RegistryData {
  tokens: Record<string, TokenInfo>;
  contracts: Record<string, Address>;
  fetchedAt: number;
  version: string;
}

class ContractRegistry {
  private data: RegistryData;

  constructor() {
    this.data = {
      version: "matsnet-placeholder-0",
      fetchedAt: Date.now(),
      tokens: {
        BTC: { symbol: "BTC", address: "native", decimals: 18 },
        MUSD: { symbol: "MUSD", address: ZERO, decimals: 18 },
        MEZO: { symbol: "MEZO", address: ZERO, decimals: 18 },
        MUSDC: { symbol: "MUSDC", address: ZERO, decimals: 6 },
      },
      contracts: {
        BorrowerOperations: ZERO,
        TroveManager: ZERO,
        SortedTroves: ZERO,
        HintHelpers: ZERO,
        PriceFeed: ZERO,
        Router: ZERO,
        VotingEscrowBTC: ZERO,
        VotingEscrowMEZO: ZERO,
        Voter: ZERO,
        Matchbox: ZERO,
        Market: ZERO,
      },
    };
  }

  get version(): string {
    return this.data.version;
  }

  get chainId(): number {
    return config.chain.chainId;
  }

  resolveToken(symbol: string): TokenInfo | undefined {
    return this.data.tokens[symbol.toUpperCase()];
  }

  isKnownToken(symbol: string): boolean {
    return this.resolveToken(symbol) !== undefined;
  }

  resolveContract(name: keyof RegistryData["contracts"] | string): Address | undefined {
    return this.data.contracts[name];
  }

  listPools(): string[] {
    // Placeholder pool list surfaced to the reasoning layer as context.
    return ["MUSD/MUSDC", "BTC/MUSD", "MEZO/MUSD"];
  }
}

export const registry = new ContractRegistry();
