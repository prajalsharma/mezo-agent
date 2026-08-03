import { toFunctionSelector, type Address } from "viem";
import { publicClient } from "./client.js";
import { env } from "../config/env.js";
import { log, errMsg } from "../core/log.js";

/**
 * What the DEPLOYED FeeRouter can actually do.
 *
 * The contract source moves faster than the deployment. Calling a function the
 * live bytecode does not contain reverts with no useful reason, and the user
 * sees "the transaction reverted on-chain" after their approval has already been
 * mined - which is exactly what happened when the zap surface was pointed at
 * `zapLegWithFee` while testnet still ran a router that only has `swapWithFee`.
 *
 * So the bot asks the chain what it is talking to instead of assuming. Probed
 * once from the deployed bytecode and cached for the process: a redeploy is an
 * operator action, and a restart follows it.
 */
type Caps = { zapLeg: boolean; referrerOf: boolean };

const SEL = {
  zapLeg: toFunctionSelector(
    "function zapLegWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)",
  ).slice(2),
  referrerOf: toFunctionSelector("function referrerOf(address)").slice(2),
};

let cached: Promise<Caps> | undefined;

export function feeRouterCaps(): Promise<Caps> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<Caps> {
  if (!env.contracts.feeRouter) return { zapLeg: false, referrerOf: false };
  try {
    const code = await publicClient().getCode({ address: env.contracts.feeRouter as Address });
    const caps = {
      zapLeg: !!code?.includes(SEL.zapLeg),
      referrerOf: !!code?.includes(SEL.referrerOf),
    };
    log.info("feeRouter.caps", { address: env.contracts.feeRouter, ...caps });
    return caps;
  } catch (e) {
    // Assume the OLDER shape on an RPC failure: every capability here is an
    // addition, so the conservative guess is the one that still executes.
    log.warn("feeRouter.caps-probe-failed", { error: errMsg(e) });
    return { zapLeg: false, referrerOf: false };
  }
}

/** Test seam - drops the cached probe. */
export function resetFeeRouterCaps(): void {
  cached = undefined;
}
