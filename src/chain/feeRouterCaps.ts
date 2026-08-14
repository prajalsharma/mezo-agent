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
/**
 * `probed` distinguishes "we READ the bytecode and it lacks this function" from
 * "we could not read the bytecode at all". Collapsing those two into one
 * `false` is what made an RPC blip indistinguishable from an old router — and
 * because the failure was cached for the process lifetime, one blip at startup
 * permanently mispriced every referred trade (see referral.ts).
 */
type Caps = { zapLeg: boolean; referrerOf: boolean; probed: boolean };

const SEL = {
  zapLeg: toFunctionSelector(
    "function zapLegWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)",
  ).slice(2),
  referrerOf: toFunctionSelector("function referrerOf(address)").slice(2),
};

/** Only a SUCCESSFUL probe is cached — see below. */
let cached: Promise<Caps> | undefined;

export function feeRouterCaps(): Promise<Caps> {
  cached ??= probe().then((caps) => {
    // NEVER memoise a failure. `cached ??= probe()` froze the resolved fallback
    // for the life of the process, so a single transient RPC error at startup
    // permanently convinced the bot it was talking to a legacy router. That is
    // not a conservative guess — it silently switched off the on-chain referral
    // binding check for every trade until the next restart.
    if (!caps.probed) cached = undefined;
    return caps;
  });
  return cached;
}

async function probe(): Promise<Caps> {
  // No router configured is a KNOWN state, not a failed read.
  if (!env.contracts.feeRouter) return { zapLeg: false, referrerOf: false, probed: true };
  try {
    const code = await publicClient().getCode({ address: env.contracts.feeRouter as Address });
    if (!code || code === "0x") {
      log.warn("feeRouter.caps-no-code", { address: env.contracts.feeRouter });
      return { zapLeg: false, referrerOf: false, probed: false };
    }
    const caps = {
      zapLeg: code.includes(SEL.zapLeg),
      referrerOf: code.includes(SEL.referrerOf),
      probed: true,
    };
    log.info("feeRouter.caps", { address: env.contracts.feeRouter, ...caps });
    return caps;
  } catch (e) {
    // Report the capabilities as absent (so nothing calls a function that may
    // not exist) but mark the read as UNSUCCESSFUL, so callers that must fail
    // closed on uncertainty can tell the difference.
    log.warn("feeRouter.caps-probe-failed", { error: errMsg(e) });
    return { zapLeg: false, referrerOf: false, probed: false };
  }
}

/** Test seam - drops the cached probe. */
export function resetFeeRouterCaps(): void {
  cached = undefined;
}
