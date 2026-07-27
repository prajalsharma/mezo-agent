import {
  createWalletClient,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { env } from "../config/env.js";
import { chainFor } from "./networks.js";
import { publicClient } from "./client.js";

/**
 * EIP-7702 support for Mezo (Prague-active; type-`0x04` set-code transactions).
 *
 * This module holds the deterministic, read-only helpers for the 7702 custody
 * path:
 *   1. detecting whether an account is delegated, and to what, from its code;
 *   2. a behavioral capability probe (Mezo does NOT expose `eth_config`, so we
 *      cannot ask the node for its active forks — we have to exercise the
 *      feature instead).
 *
 * Signing/submission of set-code transactions lives in the isolated signer, not
 * here. This file never touches user key material.
 */

/**
 * A delegated EOA's code is exactly the 23-byte designator `0xef0100 || target`.
 * `eth_getCode` returns this verbatim on a Prague-active chain (Mezo included).
 */
export const DELEGATION_PREFIX = "0xef0100" as const;
const DESIGNATOR_LENGTH_HEX = 2 + 3 * 2 + 20 * 2; // "0x" + 3 prefix bytes + 20 addr bytes

/** Sentinel target that clears a delegation (per EIP-7702, `target = 0x0`). */
export const CLEARED_DELEGATION = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Parse an `eth_getCode` result into the contract an EOA is delegated to.
 * Returns undefined for a plain EOA (empty code) or ordinary contract bytecode.
 */
export function parseDelegation(code: Hex | undefined): Address | undefined {
  if (!code) return undefined;
  const lower = code.toLowerCase();
  if (!lower.startsWith(DELEGATION_PREFIX)) return undefined;
  if (lower.length !== DESIGNATOR_LENGTH_HEX) return undefined;
  const target = (`0x${lower.slice(DELEGATION_PREFIX.length)}`) as Address;
  return target;
}

export type DelegationStatus =
  | { delegated: false }
  | { delegated: true; target: Address; matchesExpected: boolean };

/**
 * Read the on-chain delegation status of an account. `expected` (the registry's
 * Delegate7702) lets callers assert the account is pointed at OUR module and not
 * some other contract — a check the signer should make before it trusts an
 * account's session-key semantics.
 */
export async function getDelegation(
  address: Address,
  expected?: Address,
): Promise<DelegationStatus> {
  const code = await publicClient().getCode({ address });
  const target = parseDelegation(code);
  if (!target || isAddressEqual(target, CLEARED_DELEGATION)) {
    return { delegated: false };
  }
  return {
    delegated: true,
    target,
    matchesExpected: expected ? isAddressEqual(target, expected) : false,
  };
}

export type Probe7702Result = {
  supported: boolean;
  detail: string;
};

/**
 * Behavioral capability probe for EIP-7702 on the configured network.
 *
 * Mezo docs state Prague (and type-`0x04`) is active on mainnet at genesis / via
 * the v11.0 upgrade — but a given RPC endpoint could be stale or a misconfigured
 * proxy. Since `eth_config` (EIP-7910) is not supported on Mezo, we cannot ask;
 * we sign a throwaway authorization with an ephemeral key and submit it on an
 * `eth_call` (a read — no state change, no funds). A node that understands 7702
 * accepts the `authorizationList`; one that does not surfaces an error we report
 * verbatim. The authorization targets a harmless non-precompile address so Mezo's
 * precompile-target rejection rule never trips.
 */
export async function probe7702Support(): Promise<Probe7702Result> {
  const chain = chainFor(env.network);
  try {
    // Ephemeral, unfunded account — used only to produce a valid signature.
    const ephemeral = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({
      account: ephemeral,
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });

    // Delegate to a benign, non-precompile address (a burn-style address well
    // outside Mezo's 0x7b7c… precompile range).
    const authorization = await wallet.signAuthorization({
      account: ephemeral,
      contractAddress: "0x000000000000000000000000000000000000dEaD" as Address,
      executor: "self",
    });

    // Read-only: apply the authorization then call the (now-delegated) EOA.
    await publicClient().call({
      account: ephemeral.address,
      to: ephemeral.address,
      authorizationList: [authorization],
    });

    return {
      supported: true,
      detail: `type-0x04 accepted on ${chain.name} (chainId=${chain.id})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The call may still "succeed" logically; only treat clear 7702/tx-type
    // rejections as unsupported. Anything else is reported for the operator.
    if (/authorization|7702|set.?code|type.*0x04|unsupported/i.test(msg)) {
      return { supported: false, detail: `endpoint rejected 7702: ${firstLine(msg)}` };
    }
    return { supported: false, detail: `probe inconclusive: ${firstLine(msg)}` };
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.slice(0, 200);
}
