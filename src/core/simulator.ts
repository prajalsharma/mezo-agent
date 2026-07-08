import { type Address, type Hex, BaseError, ContractFunctionRevertedError } from "viem";
import { publicClient } from "../chain/client.js";

/**
 * Simulate-before-sign. Every state-changing plan is dry-run with eth_call from
 * the user's address before a confirmation is shown. A revert here means the tx
 * would fail on-chain — we surface the decoded reason instead of asking the user
 * to confirm a doomed transaction.
 */
export type SimResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function simulateCall(params: {
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
}): Promise<SimResult> {
  try {
    await publicClient().call({
      account: params.from,
      to: params.to,
      data: params.data,
      value: params.value,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: decodeRevert(err) };
  }
}

/** Translate a viem/RPC error into a plain-language reason. */
export function decodeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.reason ?? reverted.shortMessage ?? "reverted";
    }
    // Common, human-mappable cases.
    const msg = err.shortMessage ?? err.message;
    if (/insufficient funds/i.test(msg)) return "Insufficient BTC to cover amount + gas.";
    if (/gas required exceeds/i.test(msg)) return "Transaction would run out of gas.";
    return msg;
  }
  return err instanceof Error ? err.message : "Unknown simulation error.";
}
