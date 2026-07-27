/**
 * ABI for SessionKeyDelegate (contracts/src/SessionKeyDelegate.sol) — the
 * EIP-7702 delegate the account's root EOA points at.
 *
 * `registerSession` takes a TargetPolicy[] rather than a flat address list: each
 * target carries the function selectors the session may call on it plus per-tx /
 * trailing-24h caps on any ERC-20 amount decoded from calldata. That is what
 * makes the on-chain scope bound token value, not just native value.
 */
const TARGET_POLICY = {
  name: "policies",
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "selectors", type: "bytes4[]" },
    { name: "tokenPerTxCap", type: "uint128" },
    { name: "tokenDailyCap", type: "uint128" },
  ],
} as const;

export const sessionKeyDelegateAbi = [
  {
    type: "function",
    name: "registerSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "address" },
      { name: "expiry", type: "uint48" },
      { name: "perTxCap", type: "uint128" },
      { name: "dailyCap", type: "uint128" },
      TARGET_POLICY,
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTargetPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "address" },
      {
        name: "policy",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "selectors", type: "bytes4[]" },
          { name: "tokenPerTxCap", type: "uint128" },
          { name: "tokenDailyCap", type: "uint128" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeTarget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "address" },
      { name: "target", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "getSession",
    stateMutability: "view",
    inputs: [{ name: "key", type: "address" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "expiry", type: "uint48" },
      { name: "perTxCap", type: "uint128" },
      { name: "dailyCap", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "isAllowed",
    stateMutability: "view",
    inputs: [
      { name: "key", type: "address" },
      { name: "target", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isSelectorAllowed",
    stateMutability: "view",
    inputs: [
      { name: "key", type: "address" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "nativeUsage",
    stateMutability: "view",
    inputs: [{ name: "key", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
