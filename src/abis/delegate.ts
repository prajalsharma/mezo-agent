/**
 * ABI for SessionKeyDelegate (contracts/src/SessionKeyDelegate.sol) — the
 * EIP-7702 delegate the account's root EOA points at. Only the functions the
 * bot needs are included: session management (root-only) and `execute`
 * (session-key path), plus the `getSession` view.
 */
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
      { name: "targets", type: "address[]" },
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
    name: "setTarget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "address" },
      { name: "target", type: "address" },
      { name: "allowed", type: "bool" },
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
      { name: "dayStart", type: "uint48" },
      { name: "perTxCap", type: "uint128" },
      { name: "dailyCap", type: "uint128" },
      { name: "spentToday", type: "uint128" },
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
] as const;
