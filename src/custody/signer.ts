import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type TransactionRequest,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { chainFor } from "../chain/networks.js";
import type { UserRecord } from "../db/store.js";
import { LocalKeyStore } from "./localKeystore.js";

/**
 * Signer — the isolated write path. Its only job is: "sign & submit this
 * operation IF it is within policy." It independently re-checks policy before
 * signing (defense in depth) and only ever touches the key inside the KeyStore
 * `use` callback, so no key material is exposed to the rest of the system.
 *
 * In production this runs as a separate process fronting a KMS/MPC signer; the
 * interface is identical.
 */

export type SignablePlan = {
  /** Already simulated and confirmed by the user. */
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Human policy metadata the signer re-validates. */
  policy: {
    /** Contracts the app intends to touch — signer rejects anything else. */
    allowedTargets: Address[];
  };
};

export class PolicyViolationError extends Error {}

const keystore = new LocalKeyStore();

function assertPolicy(user: UserRecord, plan: SignablePlan): void {
  if (user.mode === "watch-only") {
    throw new PolicyViolationError("Account is in watch-only mode; refusing to sign.");
  }
  const allowed = plan.policy.allowedTargets.map((a) => a.toLowerCase());
  if (!allowed.includes(plan.to.toLowerCase())) {
    throw new PolicyViolationError(
      `Target ${plan.to} is not in the allowlist for this action; refusing to sign.`,
    );
  }
}

export async function signAndSubmit(user: UserRecord, plan: SignablePlan): Promise<Hex> {
  assertPolicy(user, plan);
  const chain = chainFor(env.network);

  return keystore.use(user.sealedKey, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== user.address.toLowerCase()) {
      throw new PolicyViolationError("Sealed key does not match the account address.");
    }
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });
    const request: TransactionRequest = {
      to: plan.to,
      data: plan.data,
      value: plan.value,
    };
    // viem estimates gas / fees; native BTC is the gas asset on Mezo.
    return wallet.sendTransaction(request as never);
  });
}
