import { encodeFunctionData, parseEther, parseUnits, type Address } from "viem";
import { registry } from "../registry/registry.js";
import { publicClient } from "../chain/client.js";
import { votingEscrowAbi } from "../abis/mezo.js";
import { approveStep } from "./earn.js";
import { txnFee } from "./fees.js";
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

/** Maximum lock horizon, in days, for an escrow's asset. */
function maxLockDays(asset: "BTC" | "MEZO"): number {
  return asset === "BTC" ? VE_BTC_MAX_DAYS : VE_MEZO_MAX_DAYS;
}

/**
 * The lock's current unlock timestamp, or 0n if unreadable.
 *
 * Needed because `increaseUnlockTime` takes a duration from NOW, so extending a
 * lock correctly is impossible without knowing where it currently ends.
 */
async function lockEnd(ve: Address, tokenId: bigint): Promise<bigint> {
  try {
    const locked = (await publicClient().readContract({
      address: ve,
      abi: [{ type: "function", name: "locked", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "amount", type: "int128" }, { name: "end", type: "uint256" }] }] as const,
      functionName: "locked", args: [tokenId],
    })) as readonly [bigint, bigint];
    return locked[1];
  } catch {
    return 0n;
  }
}

export function buildLock(intent: LockIntent): ActionPlan {
  const amount = Number(intent.amount);
  if (amount <= 0) throw new ActionUnavailableError("Lock amount must be greater than zero.");
  const maxDays = intent.asset === "BTC" ? VE_BTC_MAX_DAYS : VE_MEZO_MAX_DAYS;
  if (intent.lockDays > maxDays) {
    throw new ActionUnavailableError(
      `${intent.asset} locks are capped at ${maxDays} days` +
        (intent.asset === "BTC" ? " (veBTC is a short-term lock; veMEZO goes up to 4 years)" : "") +
        `.\n\nTry: lock ${intent.amount} ${intent.asset} for ${maxDays} days`,
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
      reason: `Preview only - ${key} isn't confirmed on this deployment yet. Calldata is built to the VotingEscrow interface and executes once the address lands.` });
  }

  const ve = registry.contract(key);
  const duration = BigInt(intent.lockDays * DAY);
  const value = parseUnits(intent.amount, 18);
  // Both escrows take the ERC-20 path. Native BTC is spent through its ERC-20
  // precompile (registry.erc20Of("BTC") == 0x7b7C…0000), which mirrors the
  // native balance — so no msg.value is attached and no wrapping step exists.
  const tokenAddr = intent.asset === "BTC" ? registry.erc20Of("BTC")! : registry.erc20Of("MEZO")!;
  // Agent fee (Mezo-approved) on the locked amount, in the locked asset, AFTER
  // the lock confirms.
  const agentFee = txnFee(registry.token(intent.asset), value);
  if (agentFee.summaryLine) summary.push(agentFee.summaryLine);
  const steps: ActionStep[] = [
    approveStep(tokenAddr, ve, value, intent.asset),
    {
      kind: "createLock", to: ve, value: 0n,
      data: encodeFunctionData({ abi: votingEscrowAbi, functionName: "createLock", args: [value, duration] }),
      describe: `Lock ${intent.amount} ${intent.asset} for ${intent.lockDays}d`,
      waitForReceipt: agentFee.step !== undefined,
    },
    ...(agentFee.step ? [agentFee.step] : []),
  ];
  return {
    action: "lock", title: `🔒 Lock ${intent.asset} (ve${intent.asset})`, summary,
    // Plain-language risk line: the ONE thing lockers must understand.
    warnings: [`Locked ${intent.asset} CANNOT be unlocked early - it stays committed until the full ${intent.lockDays} days pass.`],
    steps, allowedTargets: [...steps.filter((s) => s.kind !== "fee").map((s) => s.to), ...(agentFee.target ? [agentFee.target] : [])],
    executable: true,
    // Step-up threshold is BTC-denominated; only a BTC lock counts (fee included).
    nativeValue: intent.asset === "BTC" ? value + (agentFee.step && intent.asset === "BTC" ? agentFee.amount : 0n) : 0n,
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
      reason: "Preview only - the VotingEscrow address isn't confirmed on this deployment yet.",
    });
  }

  const ve = registry.contract("VotingEscrowBTC");
  const asset = "BTC" as const;
  const tokenId = BigInt(intent.tokenId);
  const steps: ActionStep[] = [];
  let nativeValue = 0n;

  if (intent.addDays) {
    // increaseUnlockTime takes a DURATION MEASURED FROM NOW, not a delta added
    // to the current unlock time — the escrow computes
    // `unlockTime = floor((block.timestamp + _lockDuration) / WEEK) * WEEK`.
    //
    // Passing the raw delta therefore asked for `now + 7 days` on a lock with
    // 20 days still to run, which is EARLIER than its current unlock, and the
    // contract rejected it. "Extend by 7 days" reverted for exactly the users
    // who had the longest left to run, which is the opposite of the intent.
    //
    // So: read the current end, add the requested days to THAT, and send the
    // resulting duration from now.
    const currentEnd = await lockEnd(ve, tokenId);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const base = currentEnd > nowSec ? currentEnd : nowSec;
    const target = base + BigInt(intent.addDays * DAY);
    const duration = target - nowSec;

    // veBTC locks are capped (28 days); asking beyond the cap reverts opaquely.
    const maxDuration = BigInt(maxLockDays(asset) * DAY);
    if (duration > maxDuration) {
      const room = Number((maxDuration - (base - nowSec)) / BigInt(DAY));
      throw new ActionUnavailableError(
        `That would put the unlock ${Math.ceil(Number(duration) / DAY)} days out, but ve${asset} locks cap at ` +
          `${maxLockDays(asset)} days from today. ` +
          (room > 0
            ? `You can extend by at most ${room} more day(s) right now.`
            : `This lock is already at the maximum - extend it again once some time has passed.`),
      );
    }
    if (currentEnd > 0n) {
      summary.push(`• New unlock: ${new Date(Number(target) * 1000).toUTCString()}`);
    }
    steps.push({
      kind: "extendLock", to: ve, value: 0n,
      data: encodeFunctionData({
        abi: votingEscrowAbi, functionName: "increaseUnlockTime",
        // The DURATION FROM NOW that lands on the target unlock time.
        args: [tokenId, duration],
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
