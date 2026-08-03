import { decodeFunctionData, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { publicClient } from "./client.js";
import { log, errMsg } from "../core/log.js";

/**
 * Wait for a transaction receipt by polling `eth_getTransactionReceipt` directly.
 *
 * Why not viem's `waitForTransactionReceipt`: it watches for new blocks and
 * derives the receipt from that stream. Against Mezo's RPC that stream stalls -
 * a transaction confirms on-chain while the watcher never fires, and the call
 * throws `WaitForTransactionReceiptTimeoutError` for a transaction that is
 * already mined. Observed live: approval 0x0636a9ac... succeeded on-chain and
 * the bot still reported "approval not confirmed within 90s" and aborted the
 * swap, stranding the user mid-plan.
 *
 * Polling the receipt endpoint asks the question we actually care about ("is
 * this mined?") instead of inferring it from a side channel, and a transient
 * RPC error becomes one skipped poll rather than a failed transaction.
 */
export async function awaitReceipt(
  hash: Hash,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TransactionReceipt | undefined> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let transientErrors = 0;

  for (;;) {
    try {
      const receipt = await publicClient().getTransactionReceipt({ hash });
      if (receipt) return receipt;
    } catch (e) {
      // A not-yet-mined transaction throws TransactionReceiptNotFoundError -
      // that is the expected path while we wait, not a failure, so it must not
      // be logged as one. Anything else means the RPC itself is unhealthy and is
      // surfaced periodically.
      if (!/not\s*be\s*found|not found/i.test(errMsg(e)) && ++transientErrors % 10 === 0) {
        log.warn("receipt.poll-error", { hash, error: errMsg(e), transientErrors });
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * How long to wait for a receipt before giving up. Deliberately generous: the
 * cost of waiting is a slower reply, the cost of giving up early is an aborted
 * plan and a stranded approval.
 */
export const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Did this approval step actually take effect?
 *
 * The point of an approval is the allowance, not the receipt. If the receipt
 * poll times out but the allowance is already sufficient, the step succeeded and
 * aborting the plan would be wrong - that is exactly the case that stranded a
 * user mid-swap. Decodes the step's own `approve(spender, amount)` calldata so
 * the check needs nothing the step doesn't already carry.
 */
export async function approvalSatisfied(
  token: Address,
  data: Hex | undefined,
  owner: Address,
): Promise<boolean> {
  if (!data) return false;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== "approve") return false;
    const [spender, amount] = decoded.args as [Address, bigint];
    const allowance = (await publicClient().readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
    return allowance >= amount;
  } catch (e) {
    log.warn("receipt.allowance-check-failed", { token, error: errMsg(e) });
    return false;
  }
}
