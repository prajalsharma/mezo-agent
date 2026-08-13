import type { Address } from "viem";
import { env } from "../config/env.js";
import {
  ALL_CONTRACT_KEYS,
  SEED_REGISTRY,
  WRAPPED_NATIVE_ADDRESS,
  type ContractKey,
  type NetworkRegistry,
  type PoolInfo,
  type TokenInfo,
  type VaultInfo,
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
    const seed = SEED_REGISTRY[env.network];
    // Merge operator-supplied confirmed addresses (from env) over the seed —
    // this is how the canonical Router / delegate get wired without editing code
    // or inventing an address. Anything unset stays gated.
    const contracts = { ...seed.contracts };

    // Generic MEZO_ADDR_<KEY> overrides for every ContractKey, matched
    // case-insensitively so MEZO_ADDR_BORROWEROPERATIONS finds
    // "BorrowerOperations". An unknown key is ignored rather than silently
    // creating a bogus entry.
    for (const [lowerKey, addr] of Object.entries(env.contractOverrides)) {
      const match = ALL_CONTRACT_KEYS.find((k) => k.toLowerCase() === lowerKey);
      if (match) contracts[match] = addr as Address;
    }

    // Legacy named vars still work and take precedence, so existing
    // deployments and docs do not break.
    if (env.contracts.router) contracts.Router = env.contracts.router as Address;
    if (env.contracts.delegate7702) contracts.Delegate7702 = env.contracts.delegate7702 as Address;
    if (env.contracts.feeRouter) contracts.FeeRouter = env.contracts.feeRouter as Address;

    // A key that now has an address is, by definition, no longer awaiting
    // confirmation — otherwise `needsConfirmation` would keep reporting a
    // wired contract as pending.
    const needsConfirmation = seed.needsConfirmation.filter((k) => !contracts[k]);
    this.data = { ...seed, contracts, needsConfirmation };
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

  /** The active network's human name (for error messages). */
  networkName(): string {
    return env.network;
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

  /** All DEX pools on this network. */
  pools(): PoolInfo[] {
    return this.data.pools;
  }

  /** Published Mezo Earn vaults on this network. */
  vaults(): VaultInfo[] {
    return this.data.vaults;
  }

  /** The vault whose deposit asset is `symbol` (case-insensitive), if any. */
  vaultForAsset(symbol: string): VaultInfo | undefined {
    return this.data.vaults.find((v) => v.assetSymbol.toLowerCase() === symbol.toLowerCase());
  }

  /** Find the pool trading two symbols, regardless of order. Undefined if none. */
  resolvePool(a: string, b: string): PoolInfo | undefined {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return this.data.pools.find((p) => {
      const [p0, p1] = [p.pair[0].toLowerCase(), p.pair[1].toLowerCase()];
      return (p0 === x && p1 === y) || (p0 === y && p1 === x);
    });
  }

  /**
   * ERC-20 routing address for a token. Native BTC routes through its wrapped
   * precompile; every other token uses its own address. Used for DEX quoting.
   */
  routingAddress(token: TokenInfo): Address {
    return token.native ? WRAPPED_NATIVE_ADDRESS : token.address;
  }

  /** ERC-20 address for a symbol (native BTC maps to its precompile). Undefined if unknown. */
  erc20Of(symbol: string): Address | undefined {
    const t = this.tryToken(symbol);
    return t ? this.routingAddress(t) : undefined;
  }

  /** Whether an address is provisional and must be confirmed on-chain. */
  needsConfirmation(key: ContractKey): boolean {
    return this.data.needsConfirmation.includes(key);
  }

  /**
   * Every address this deployment considers legitimate: contracts, tokens (and
   * their routing addresses), pools, and vaults.
   *
   * The signer checks against this so its target allowlist is an INDEPENDENT
   * fact rather than a claim the plan makes about itself. Compiled in and
   * lower-cased once; the registry is immutable at runtime.
   */
  knownAddresses(): ReadonlySet<string> {
    if (!this._known) {
      const set = new Set<string>();
      for (const a of Object.values(this.data.contracts)) if (a) set.add(a.toLowerCase());
      for (const t of Object.values(this.data.tokens)) {
        set.add(t.address.toLowerCase());
        set.add(this.routingAddress(t).toLowerCase());
      }
      for (const p of this.data.pools) set.add(p.address.toLowerCase());
      for (const v of this.data.vaults) set.add(v.address.toLowerCase());
      set.add(WRAPPED_NATIVE_ADDRESS.toLowerCase());
      this._known = set;
    }
    return this._known;
  }
  private _known?: Set<string>;
}

export const registry = new ContractRegistry();
