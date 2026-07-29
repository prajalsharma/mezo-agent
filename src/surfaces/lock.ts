import { encodeFunctionData, parseEther, parseUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { votingEscrowAbi } from "../abis/mezo.js";
import { approveStep } from "./earn.js";
import { ActionUnavailableError, gatedPlan, type ActionPlan, type ActionStep } from "./plan.js";
import type { LockIntent, ExtendLockIntent } from "../llm/intent.js";

/**
 * Locking surface — veBTC (lock native BTC, 1–28 days) and veMEZO (lock MEZO,
 * up to 4 years). veBTC gives base voting power + a BTC-denominated fee claim;
 * veMEZO boosts a paired veBTC position up to 5× (see Matchbox). Extend adds
 * time and/or amount to an existing lock.
 */

const VE_BTC_MAX_DAYS = 28;
const VE_MEZO_MAX_DAYS = 4 * 365;
const DAY = 24 * 60 * 60;

export function buildLock(intent: LockIntent): ActionPlan {
  const amount = Number(intent.amount);
  if (amount <= 0) throw new ActionUnavailableError("Lock amount must be greater than zero.");
  const maxDays = intent.asset === "BTC" ? VE_BTC_MAX_DAYS : VE_MEZO_MAX_DAYS;
  if (intent.lockDays > maxDays) {
    throw new ActionUnavailableError(
      `${intent.asset} locks are capped at ${maxDays} days. Reduce the duration.`,
    );
  }
  const key = intent.asset === "BTC" ? "VotingEscrowBTC" : "VotingEscrowMEZO";
  const endDate = new Date(Date.now() + intent.lockDays * DAY * 1000).toISOString().slice(0, 10);
  const summary = [
    `Lock ${intent.amount} ${intent.asset} for ${intent.lockDays} days (unlocks ~${endDate}).`,
    intent.asset === "BTC"
      ? "veBTC gives voting power + a claim on protocol fees (paid largely in BTC)."
      : "veMEZO boosts a paired veBTC position up to 5× (pair it via Matchbox).",
  ];

  if (!registry.hasContract(key)) {
    return gatedPlan({ action: "lock", title: `🔒 Lock ${intent.asset} (ve${intent.asset})`, summary,
      reason: `Preview only — ${key} isn't confirmed on this deployment yet. Calldata is built to the VotingEscrow interface and executes once the address lands.` });
  }

  const ve = registry.contract(key);
  const duration = BigInt(intent.lockDays * DAY);
  const value = parseUnits(intent.amount, 18);
  // Both escrows take the ERC-20 path. Native BTC is spent through its ERC-20
  // precompile (registry.erc20Of("BTC") == 0x7b7C…0000), which mirrors the
  // native balance — so no msg.value is attached and no wrapping step exists.
  const tokenAddr = intent.asset === "BTC" ? registry.erc20Of("BTC")! : registry.erc20Of("MEZO")!;
  const steps: ActionStep[] = [
    approveStep(tokenAddr, ve, value, intent.asset),
    {
      kind: "createLock", to: ve, value: 0n,
      data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "createLock", args: [value, duration] }),
      describe: `Lock ${intent.amount} ${intent.asset} for ${intent.lockDays}d`,
    },
  ];
  return {
    action: "lock", title: `🔒 Lock ${intent.asset} (ve${intent.asset})`, summary, warnings: [],
    steps, allowedTargets: steps.map((s) => s.to), executable: true,
    // Step-up threshold is BTC-denominated; only a BTC lock counts toward it.
    nativeValue: intent.asset === "BTC" ? value : 0n,
  };
}

export async function buildExtendLock(intent: ExtendLockIntent, owner: Address): Promise<ActionPlan> {
  if (!intent.addDays && !intent.addAmount) {
    throw new ActionUnavailableError("Specify more time (addDays) and/or more amount (addAmount).");
  }
  const summary: string[] = [`Extend lock #${intent.tokenId}:`];
  if (intent.addDays) summary.push(`• +${intent.addDays} days`);
  if (intent.addAmount) summary.push(`• +${intent.addAmount} to the locked amount`);

  // veBTC is the only escrow with a confirmed address today; veMEZO extends
  // activate the moment VotingEscrowMEZO lands (same calldata shape).
  if (!registry.hasContract("VotingEscrowBTC")) {
    return gatedPlan({
      action: "extendLock", title: "⏳ Extend lock", summary,
      reason: "Preview only — the VotingEscrow address isn't confirmed on this deployment yet.",
    });
  }

  const ve = registry.contract("VotingEscrowBTC");
  const tokenId = BigInt(intent.tokenId);
  const steps: ActionStep[] = [];
  let nativeValue = 0n;

  if (intent.addDays) {
    steps.push({
      kind: "extendLock", to: ve, value: 0n,
      data: encodeFunctionData({
        abi: votingEscrowAbi, functionName: "increaseUnlockTime",
        args: [tokenId, BigInt(intent.addDays * DAY)],
      }),
      describe: `Extend lock #${intent.tokenId} by ${intent.addDays} days`,
    });
  }
  if (intent.addAmount) {
    // Fund-moving branch — refuse unless the caller owns the target veNFT.
    await assertOwnsLock(owner, String(intent.tokenId));
    // Added BTC travels through the ERC-20 precompile like createLock: approve
    // the escrow, then increaseAmount — no msg.value.
    const value = parseUnits(intent.addAmount, 18);
    nativeValue += value; // BTC, for the step-up threshold
    steps.push(approveStep(registry.erc20Of("BTC")!, ve, value, "BTC"));
    steps.push({
      kind: "increaseAmount", to: ve, value: 0n,
      data: encodeFunctionData({
        abi: votingEscrowAbi, functionName: "increaseAmount",
        args: [tokenId, value],
      }),
      describe: `Add ${intent.addAmount} BTC to lock #${intent.tokenId}`,
      erc20: { symbol: "BTC", amount: value },
    });
  }

  return {
    action: "extendLock", title: "⏳ Extend lock", summary,
    warnings: ["Extending resets voting-power decay; the new unlock date is checked on-chain before signing."],
    steps, allowedTargets: steps.map((s) => s.to), executable: true, nativeValue,
  };
}

/**
 * increaseAmount() in a Velodrome-style escrow is a "deposit-for" call: it does
 * NOT require msg.sender to own the veNFT, so a wrong/misparsed tokenId would
 * irrecoverably donate the caller's BTC into a stranger's lock. Guard it with an
 * off-chain ownership check before building the fund-moving step. (Audit R2.)
 */
export async function assertOwnsLock(owner: Address, tokenId: string): Promise<void> {
  const { publicClient } = await import("../chain/client.js");
  const nftOwner = (await publicClient().readContract({
    address: registry.contract("VotingEscrowBTC"),
    abi: votingEscrowAbi, functionName: "ownerOf", args: [BigInt(tokenId)],
  })) as Address;
  if (nftOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new ActionUnavailableError(
      `veNFT #${tokenId} is not owned by your account, so adding BTC to it would give the funds away. Check the id.`,
    );
  }
}
