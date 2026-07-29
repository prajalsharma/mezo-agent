import { encodeFunctionData, formatUnits, type Address } from "viem";
import { env, txnFeesEnabled } from "../config/env.js";
import { registry } from "../registry/registry.js";
import { erc20Abi } from "../abis/erc20.js";
import type { ActionStep } from "./plan.js";
import type { TokenInfo } from "../registry/addresses.js";

/**
 * Agent fee on non-swap fund-moving actions (borrow / vault deposit / lock),
 * approved by the Mezo team. `AGENT_TXN_FEE_BPS` of the action's own amount,
 * taken in that token, transferred to the fee recipient. Off by default.
 *
 * The fee is always charged as the LAST step and AFTER the action it applies to
 * has confirmed (the caller marks the preceding step waitForReceipt), so a
 * failed borrow/lock/deposit never costs a fee — same discipline as swaps
 * (Audit R3 F1).
 */
export function computeTxnFee(rawAmount: bigint): bigint {
  return txnFeesEnabled ? (rawAmount * BigInt(env.fees.txnBps)) / 10_000n : 0n;
}

export type TxnFee = {
  amount: bigint;
  /** The fee step to append LAST, or undefined when no fee applies. */
  step?: ActionStep;
  /** Address the signer must additionally allow (fee recipient / token). */
  target?: Address;
  /** One-line disclosure for the confirmation summary. */
  summaryLine?: string;
};

/**
 * Build the fee for an action moving `rawAmount` of `token`. Native BTC pays as
 * a plain value transfer; ERC-20 tokens (MUSD, MEZO, mUSDC…) as a transfer.
 */
export function txnFee(token: TokenInfo, rawAmount: bigint): TxnFee {
  const amount = computeTxnFee(rawAmount);
  if (amount <= 0n) return { amount: 0n };
  const recipient = env.fees.recipient as Address;
  const human = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  const summaryLine = `Agent fee: ${human} (${env.fees.txnBps / 100}%)`;
  if (token.native) {
    return {
      amount, target: recipient, summaryLine,
      step: { kind: "fee", to: recipient, value: amount, describe: `Agent fee ${human}` },
    };
  }
  return {
    amount, target: token.address, summaryLine,
    step: {
      kind: "fee", to: token.address, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }),
      describe: `Agent fee ${human}`,
      erc20: { symbol: token.symbol, amount },
    },
  };
}

/** The MUSD token (borrow fee is taken from the minted MUSD). */
export function musdToken(): TokenInfo {
  return registry.token("MUSD");
}
