import type { Address } from "viem";
import { env } from "../config/env.js";
import {
  SEED_REGISTRY,
  type ContractKey,
  type NetworkRegistry,
  type TokenInfo,
} from "./addresses.js";

/**
 * ContractRegistry — the single source of truth for addresses and token metadata.
 *
 * Phase 1 serves the seeded snapshot from addresses.ts. It is deliberately shaped
 * so a later `refresh()` can re-fetch the canonical contracts reference / a
 * subgraph and diff it (a maintenance requirement in the architecture) without
 * changing any call site.
 */
class ContractRegistry {
  private data: NetworkRegistry;

  constructor() {
    this.data = SEED_REGISTRY[env.network];
  }

  /** Resolve a token by symbol (case-insensitive). Throws if unknown. */
  token(symbol: string): TokenInfo {
    const key = Object.keys(this.data.tokens).find(
      (k) => k.toLowerCase() === symbol.toLowerCase(),
    );
    const token = key ? this.data.tokens[key] : undefined;
    if (!token) {
      throw new Error(
        `Unknown token "${symbol}" on ${env.network}. Known: ${this.knownTokenSymbols().join(", ")}`,
      );
    }
    return token;
  }

  tryToken(symbol: string): TokenInfo | undefined {
    try {
      return this.token(symbol);
    } catch {
      return undefined;
    }
  }

  knownTokenSymbols(): string[] {
    return Object.values(this.data.tokens).map((t) => t.symbol);
  }

  allTokens(): TokenInfo[] {
    return Object.values(this.data.tokens);
  }

  /** Resolve a contract address by key. Throws if not yet configured. */
  contract(key: ContractKey): Address {
    const addr = this.data.contracts[key];
    if (!addr) {
      throw new Error(
        `Contract "${key}" is not configured for ${env.network} yet. ` +
          `It must be sourced from the canonical contracts reference before use.`,
      );
    }
    return addr;
  }

  hasContract(key: ContractKey): boolean {
    return Boolean(this.data.contracts[key]);
  }

  /** Whether an address is provisional and must be confirmed on-chain. */
  needsConfirmation(key: ContractKey): boolean {
    return this.data.needsConfirmation.includes(key);
  }
}

export const registry = new ContractRegistry();
