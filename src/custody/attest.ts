import type { Address } from "viem";
import { log } from "../core/log.js";

/**
 * Addresses a builder has independently VERIFIED on-chain this session.
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
 * Those builders call `attest` after doing the verification, which records the
 * address together with WHY it is trusted. Two properties keep this from
 * becoming a general-purpose bypass: nothing derived from model output may be
 * attested (every caller here reads from a registry contract or the local
 * store), and attestations expire, so a stale one cannot outlive the flow that
 * justified it.
 */

const TTL_MS = 10 * 60 * 1000;

type Attestation = { reason: string; expiresAt: number };

const attested = new Map<string, Attestation>();

/** Record that `address` was verified on-chain, and why. */
export function attest(address: Address, reason: string): void {
  attested.set(address.toLowerCase(), { reason, expiresAt: Date.now() + TTL_MS });
}

/** Has `address` been verified this session, and not yet expired? */
export function isAttested(address: Address): boolean {
  const key = address.toLowerCase();
  const a = attested.get(key);
  if (!a) return false;
  if (Date.now() > a.expiresAt) {
    attested.delete(key);
    return false;
  }
  return true;
}

/** Why an address is trusted, for diagnostics. */
export function attestationReason(address: Address): string | undefined {
  return attested.get(address.toLowerCase())?.reason;
}

/** Test seam - forget every attestation. */
export function resetAttestations(): void {
  attested.clear();
  log.info("attest.reset");
}
