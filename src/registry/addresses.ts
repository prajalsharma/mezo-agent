import type { Address } from "viem";
import type { NetworkName } from "../config/env.js";

/**
 * Canonical Mezo contract addresses, transcribed from:
 *   https://mezo.org/docs/users/resources/contracts-reference/
 *
 * ARCHITECTURE INVARIANT: addresses come from this registry, never from the LLM
 * and never hardcoded at a call site. The registry is the single source of truth
 * and is designed to be refreshed from the canonical source (see registry.ts).
 *
 * `confirm: true` marks an address that must be verified on-chain (via the
 * explorer / mezo-org GitHub) before it is used on mainnet. The DEX router in
 * particular is a documented week-one open question — the swap builder targets
 * the standard Velodrome-style Router V2 interface and reads the address here.
 */

export type TokenInfo = {
  symbol: string;
  name: string;
  address: Address; // "native" tokens use the sentinel below
  decimals: number;
  native?: boolean;
};

/**
 * A DEX pool (Velodrome-style pair). The pool itself exposes
 * `getAmountOut(amountIn, tokenIn)` computed from live reserves, so we can quote
 * a swap directly from the pool WITHOUT depending on a Router address.
 */
export type PoolInfo = {
  /** The two token symbols this pool trades, in no particular order. */
  pair: [string, string];
  address: Address;
  stable: boolean;
};

export type NetworkRegistry = {
  tokens: Record<string, TokenInfo>;
  contracts: Partial<Record<ContractKey, Address>>;
  /** DEX pools, keyed for direct on-chain quoting. */
  pools: PoolInfo[];
  /** Contracts whose addresses are provisional and must be confirmed on-chain. */
  needsConfirmation: ContractKey[];
};

/**
 * Mezo represents native BTC as an ERC-20 precompile at this address; DEX pools
 * use it as the route endpoint for BTC. Balances are still read via getBalance,
 * so this is a routing detail, not a portfolio token.
 */
export const WRAPPED_NATIVE_ADDRESS =
  "0x7b7C000000000000000000000000000000000000" as Address;

export type ContractKey =
  | "PoolFactory"
  | "Router"
  | "BorrowerOperations"
  | "TroveManager"
  | "Voter"
  | "VotingEscrowBTC"
  | "VotingEscrowMEZO"
  /**
   * EIP-7702 session-key delegate. This is the contract an account's EOA points
   * its delegation designator at (`0xef0100 || Delegate7702`). It holds the
   * on-chain session-key state and validates that each op is within scope
   * (allowlisted target, per-tx / daily caps, expiry). Deployed per-network and
   * MUST be verified on-chain before use — and MUST NOT sit in the precompile
   * range (Mezo rejects authorizations whose target is a precompile).
   */
  | "Delegate7702";

/** Sentinel for the native gas asset (BTC on Mezo, 18 decimals). */
export const NATIVE_TOKEN_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

const MAINNET: NetworkRegistry = {
  tokens: {
    BTC: {
      symbol: "BTC",
      name: "Bitcoin (native gas)",
      address: NATIVE_TOKEN_ADDRESS,
      decimals: 18,
      native: true,
    },
    MUSD: {
      symbol: "MUSD",
      name: "Mezo USD",
      address: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
      decimals: 18,
    },
    mUSDC: {
      symbol: "mUSDC",
      name: "Mezo USDC",
      address: "0x04671C72Aab5AC02A03c1098314b1BB6B560c197",
      decimals: 6,
    },
    mUSDT: {
      symbol: "mUSDT",
      name: "Mezo USDT",
      address: "0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E",
      decimals: 6,
    },
    MEZO: {
      symbol: "MEZO",
      name: "Mezo",
      address: "0x7B7c000000000000000000000000000000000001",
      decimals: 18,
    },
  },
  contracts: {
    PoolFactory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248",
    // Router address to be confirmed on-chain — see needsConfirmation. Quoting
    // does not need it (pools expose getAmountOut); execution does.
  },
  // Canonical pools from the contracts reference; verified live on-chain
  // (getAmountOut returns non-zero, factory matches PoolFactory).
  pools: [
    { pair: ["BTC", "MUSD"], address: "0x52e604c44417233b6CcEDDDc0d640A405Caacefb", stable: false },
    { pair: ["MUSD", "mUSDC"], address: "0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356", stable: true },
    { pair: ["MUSD", "mUSDT"], address: "0x10906a9E9215939561597b4C8e4b98F93c02031A", stable: true },
  ],
  needsConfirmation: ["Router", "BorrowerOperations", "TroveManager", "Voter", "VotingEscrowBTC", "VotingEscrowMEZO", "Delegate7702"],
};

const TESTNET: NetworkRegistry = {
  tokens: {
    BTC: {
      symbol: "BTC",
      name: "Bitcoin (native gas)",
      address: NATIVE_TOKEN_ADDRESS,
      decimals: 18,
      native: true,
    },
    MUSD: {
      symbol: "MUSD",
      name: "Mezo USD",
      address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      decimals: 18,
    },
  },
  contracts: {
    // Testnet DEX / pool addresses are resolved at runtime from the canonical
    // reference or the explorer; seeded here as they are confirmed on Matsnet.
  },
  // No DEX pools are published for Matsnet testnet yet — only MUSD. Swaps quote
  // and execute on mainnet, where the pools live.
  pools: [],
  needsConfirmation: ["PoolFactory", "Router", "BorrowerOperations", "TroveManager", "Voter", "VotingEscrowBTC", "VotingEscrowMEZO", "Delegate7702"],
};

export const SEED_REGISTRY: Record<NetworkName, NetworkRegistry> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};
