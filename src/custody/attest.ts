import type { Address } from "viem";
import { log } from "../core/log.js";

/**
 * Addresses a builder has independently VERIFIED on-chain, for one user.
 *
 * The signer's target check is deliberately narrow: an address must be one the
 * compiled-in registry knows. That is what makes it an independent check rather
 * than the plan vouching for itself. But a few legitimate targets cannot be in
 * the registry, because they are discovered at runtime:
 *
 *   • gauges, read from Voter.gauges(pool) and then proven to be the real gauge
 *     for that pool by asserting gauge.stakingToken() == pool,
 *   • per-gauge bribe/fee reward contracts, read from the trusted Voter,
 *   • a referrer's payout wallet, which is another user's own account address.
 *
 * Those builders call `attest` after doing the verification. Nothing derived
 * from model output may be attested — every caller reads from a registry
 * contract or the local store.
 *
 * TWO PROPERTIES THIS GOT WRONG, both fixed here:
 *
 *   1. It was a PROCESS-GLOBAL map with no account key, so one user building
 *      a plan widened the acceptable target set for everyone else.
 *   2. The TTL was 10 minutes, shorter than a plan can legitimately take: a
 *      `claim all` runs many steps, each waiting up to RECEIPT_TIMEOUT_MS
 *      (180s) plus retries. When it expired mid-plan the signer threw a
 *      PolicyViolationError — which the executor treats as deterministic and
 *      does not retry — leaving a PARTIALLY EXECUTED plan and telling the user
 *      an address verified minutes ago "is not a known Mezo contract". Worst for
 *      the largest positions, which have the most steps.
 *
 * So attestations are per-user, and the executor REFRESHES a plan's verified
 * targets immediately before each step (see executeActionPlan), which means the
 * window cannot lapse part-way through a plan the builder already vetted.
 */

/** Comfortably longer than the longest plan, but still bounded. */
const TTL_MS = 30 * 60 * 1000;

type Attestation = { reason: string; expiresAt: number };

/**
 * Keyed `${owner}:${address}` — never address alone.
 *
 * The OWNER (the account that will sign) rather than the Telegram id, because
 * every builder already has it and the signer checks against `user.address`. It
 * is also the correct subject: the attestation says "this target is valid for a
 * plan this account is about to sign".
 */
const attested = new Map<string, Attestation>();

const key = (owner: Address, address: Address) => `${owner.toLowerCase()}:${address.toLowerCase()}`;

/** Record that `address` was verified on-chain for this account, and why. */
export function attest(owner: Address, address: Address, reason: string): void {
  attested.set(key(owner, address), { reason, expiresAt: Date.now() + TTL_MS });
}

/** Has `address` been verified for THIS account, and not yet expired? */
export function isAttested(owner: Address, address: Address): boolean {
  const k = key(owner, address);
  const a = attested.get(k);
  if (!a) return false;
  if (Date.now() > a.expiresAt) {
    attested.delete(k);
    return false;
  }
  return true;
}

/** Why an address is trusted, for diagnostics. */
export function attestationReason(owner: Address, address: Address): string | undefined {
  return attested.get(key(owner, address))?.reason;
}

/**
 * Extend the window for targets a plan already verified, so a long plan cannot
 * have an attestation lapse between its own steps. Only refreshes entries that
 * are still live — it never creates one, so it cannot launder an unverified
 * address into the trusted set.
 */
export function refreshAttestations(owner: Address, addresses: readonly Address[]): void {
  for (const a of addresses) {
    const k = key(owner, a);
    const existing = attested.get(k);
    if (existing && Date.now() <= existing.expiresAt) {
      attested.set(k, { reason: existing.reason, expiresAt: Date.now() + TTL_MS });
    }
  }
}

/** Test seam - forget every attestation. */
export function resetAttestations(): void {
  attested.clear();
  log.info("attest.reset");
}
