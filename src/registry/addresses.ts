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
  /** Mezo Earn vaults (empty where none are published). */
  vaults: VaultInfo[];
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
  // Borrow / MUSD (Liquity-style CDP)
  | "BorrowerOperations"
  | "TroveManager"
  | "SortedTroves"
  | "HintHelpers"
  | "PriceFeed"
  // Earn / ve(3,3)
  | "Voter"
  | "VotingEscrowBTC"
  | "VotingEscrowMEZO"
  | "RewardsDistributor"
  // Other surfaces
  | "Matchbox"
  | "Market"
  /**
   * EIP-7702 session-key delegate. This is the contract an account's EOA points
   * its delegation designator at (`0xef0100 || Delegate7702`). It holds the
   * on-chain session-key state and validates that each op is within scope
   * (allowlisted target, per-tx / daily caps, expiry). Deployed per-network and
   * MUST be verified on-chain before use — and MUST NOT sit in the precompile
   * range (Mezo rejects authorizations whose target is a precompile).
   */
  | "Delegate7702";

/**
 * Every ContractKey, for the generic MEZO_ADDR_<KEY> env override. Declared as a
 * value (not just a type) so the registry can match an operator-supplied key
 * name at runtime; `satisfies` keeps it in lockstep with the union above — drop
 * a key here and this file stops compiling.
 */
export const ALL_CONTRACT_KEYS = [
  "PoolFactory", "Router",
  "BorrowerOperations", "TroveManager", "SortedTroves", "HintHelpers", "PriceFeed",
  "Voter", "VotingEscrowBTC", "VotingEscrowMEZO", "RewardsDistributor",
  "Matchbox", "Market", "Delegate7702",
] as const satisfies readonly ContractKey[];

/** A Mezo Earn vault. `kind` selects the deposit ABI shape. */
export type VaultInfo = {
  name: string;
  address: Address;
  /** Registry symbol of the deposit asset. */
  assetSymbol: string;
  /**
   * "savings"  → deposit(uint256) / withdraw(uint256)   (sMUSD-style)
   * "erc4626"  → deposit(assets, receiver) / redeem(...)  (Morpho-style)
   * Shapes verified on-chain by selector extraction from the implementation
   * (EIP-1967 slot) — the sMUSD vault is NOT 4626 (no asset()/previewDeposit).
   */
  kind: "savings" | "erc4626";
};

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

    // DEX Router: docs/developers/features/mezo-pools.md, verified on-chain
    // (Router.factory == PoolFactory; getAmountsOut answers over our routes).
    Router: "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706",

    // ve(3,3) suite — the LIVE deployment, NOT the one in mezo-pools.md.
    // The docs page lists VeBTC 0x7D80…5914 / Voter 0x3A4a…2C1b, but on-chain
    // that system is a stale ghost: Voter.length() == 0 gauges and VeBTC
    // supply == 0.00096 BTC. The production system was discovered from the
    // official docs' ValidatorsVoter (validator-gauge.md, 0xe99a…515a):
    // ValidatorsVoter.ve() → this VeBTC (824.7 BTC locked), whose voter() →
    // this Voter (26 gauges, incl. every pool above), whose splitter routes
    // MEZO emissions. Full cross-refs re-verified by `npm run verifyve`
    // (Voter.ve == VeBTC, VeBTC.voter == Voter, Distributor.ve == VeBTC,
    // live gauges for all three pools). "Read addresses from the canonical
    // reference; do not hardcode stale values" — here the doc VALUE itself was
    // stale, so on-chain linkage + usage is the deciding evidence.
    VotingEscrowBTC: "0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279",
    Voter: "0x48233cCC97B87Ba93bCA212cbEe48e3210211f03",
    RewardsDistributor: "0xb58477e074265BdC7F7ca6100eD0f7De264F74A2",

    // Mezo Borrow (Liquity-style CDP). Source: the canonical MUSD developer
    // reference, https://mezo.org/docs/developers/musd/musd-redemptions.
    // Verified on-chain by `npm run verifyaddrs` — each has code, answers its
    // own interface, and all five cross-references agree
    // (BorrowerOperations.troveManager == TroveManager, .sortedTroves ==
    // SortedTroves, .priceFeed == PriceFeed, TroveManager.borrowerOperations ==
    // BorrowerOperations, HintHelpers.sortedTroves == SortedTroves), which is
    // what proves this is the linked deployment and not merely live code.
    // BorrowerOperations.musd() also matches the MUSD token below.
    BorrowerOperations: "0x44b1bac67dDA612a41a58AAf779143B181dEe031",
    TroveManager: "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193",
    HintHelpers: "0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3",
    SortedTroves: "0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f",
    PriceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
  },
  // Canonical pools from the contracts reference; verified live on-chain
  // (getAmountOut returns non-zero, factory matches PoolFactory).
  pools: [
    { pair: ["BTC", "MUSD"], address: "0x52e604c44417233b6CcEDDDc0d640A405Caacefb", stable: false },
    { pair: ["MUSD", "mUSDC"], address: "0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356", stable: true },
    { pair: ["MUSD", "mUSDT"], address: "0x10906a9E9215939561597b4C8e4b98F93c02031A", stable: true },
  ],
  // VotingEscrowMEZO, Matchbox, Market: genuinely unpublished. veMEZO has no
  // documented contract; Matchbox is a community project (matchbox.markets);
  // Mezo Market has no published contract address.
  needsConfirmation: ["VotingEscrowMEZO", "Matchbox", "Market", "Delegate7702"],
  // From docs (vault-notices.md / usdc-lending-vault.md), shapes verified
  // on-chain: sMUSD answers deposit(uint256)+withdraw(uint256) only (savings),
  // the Morpho vault is full ERC-4626 with asset() == mUSDC.
  vaults: [
    { name: "MUSD Savings Vault (sMUSD)", address: "0xb4D498029af77680cD1eF828b967f010d06C51CC", assetSymbol: "MUSD", kind: "savings" },
    { name: "USDC Lending Vault (Morpho)", address: "0x06291b67e3d7660240ab44Afc9a708d82b976a8B", assetSymbol: "mUSDC", kind: "erc4626" },
  ],
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
    // Read on-chain from the published testnet pools' token0/token1 (symbols
    // and 6-decimals confirmed via eth_call) — not copied from any doc table.
    mUSDC: {
      symbol: "mUSDC",
      name: "Mezo USDC (Matsnet)",
      address: "0xe1a26db653708A2AD8F824E92Db9852410e33A59",
      decimals: 6,
    },
    mUSDT: {
      symbol: "mUSDT",
      name: "Mezo USDT (Matsnet)",
      address: "0x629320719a6190bd145C277226fd45e7648F950A",
      decimals: 6,
    },
  },
  contracts: {
    // DEX Router + ve(3,3) on Matsnet. Same source and verification as mainnet
    // (`MEZO_NETWORK=testnet npm run verifyve`, 15/15 including per-pool
    // factory checks and a live gauge lookup for MUSD/mUSDC).
    PoolFactory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A",
    Router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9",
    VotingEscrowBTC: "0xB63fcCd03521Cf21907627bd7fA465C129479231",
    Voter: "0x72F8dd7F44fFa19E45955aa20A5486E8EB255738",
    RewardsDistributor: "0x10B0E7b3411F4A38ca2F6BB697aA28D607924729",

    // Mezo Borrow on Matsnet. Same source and same verification as mainnet:
    // `MEZO_NETWORK=testnet npm run verifyaddrs` reports 5/5 cross-references
    // and BorrowerOperations.musd() == the MUSD token below. 228 live Troves at
    // time of wiring, so this is the exercisable deployment the bounty asks us
    // to test against before mainnet.
    BorrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
    TroveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
    HintHelpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
    SortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
    PriceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  },
  // Matsnet pools from mezo-pools.md; factory() of each verified == the
  // testnet PoolFactory, token0/token1 and stable flags read on-chain.
  pools: [
    { pair: ["BTC", "MUSD"], address: "0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9", stable: false },
    { pair: ["MUSD", "mUSDC"], address: "0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e", stable: true },
    { pair: ["MUSD", "mUSDT"], address: "0x27414B76CF00E24ed087adb56E26bAeEEe93494e", stable: true },
  ],
  needsConfirmation: ["VotingEscrowMEZO", "Matchbox", "Market", "Delegate7702"],
  // No Matsnet vault addresses are published.
  vaults: [],
};

export const SEED_REGISTRY: Record<NetworkName, NetworkRegistry> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};
