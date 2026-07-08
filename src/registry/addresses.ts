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

export type NetworkRegistry = {
  tokens: Record<string, TokenInfo>;
  contracts: Partial<Record<ContractKey, Address>>;
  /** Contracts whose addresses are provisional and must be confirmed on-chain. */
  needsConfirmation: ContractKey[];
};

export type ContractKey =
  | "PoolFactory"
  | "Router"
  | "BorrowerOperations"
  | "TroveManager"
  | "Voter"
  | "VotingEscrowBTC"
  | "VotingEscrowMEZO";

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
    MEZO: {
      symbol: "MEZO",
      name: "Mezo",
      address: "0x7B7c000000000000000000000000000000000001",
      decimals: 18,
    },
  },
  contracts: {
    PoolFactory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248",
    // Router address to be confirmed on-chain — see needsConfirmation.
  },
  needsConfirmation: ["Router", "BorrowerOperations", "TroveManager", "Voter", "VotingEscrowBTC", "VotingEscrowMEZO"],
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
  needsConfirmation: ["PoolFactory", "Router", "BorrowerOperations", "TroveManager", "Voter", "VotingEscrowBTC", "VotingEscrowMEZO"],
};

export const SEED_REGISTRY: Record<NetworkName, NetworkRegistry> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};
