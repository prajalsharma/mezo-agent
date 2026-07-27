/**
 * Velodrome-style Pool (pair) ABI — the subset needed to quote a swap directly
 * from the pool's live reserves, independent of any Router. `getAmountOut`
 * returns the output amount for `amountIn` of `tokenIn`, net of the pool fee,
 * computed by the pool itself (so we never re-implement the invariant math).
 */
export const poolAbi = [
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "tokenIn", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_reserve0", type: "uint256" },
      { name: "_reserve1", type: "uint256" },
      { name: "_blockTimestampLast", type: "uint256" },
    ],
  },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "stable", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
