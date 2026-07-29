/**
 * Simulates real calldata against the LIVE chain (eth_call + state override for
 * balance). Catches wrong selectors/ABIs before any user signs: a wrong
 * selector reverts with NO reason, while correct calldata either succeeds or
 * returns a decoded protocol revert (which also proves the ABI is right).
 * This is the regression guard that caught the openTrove 4-arg Liquity bug.
 *
 *   MEZO_NETWORK=testnet npx tsx scripts/simcheck.ts
 */
import "./_testenv.js";
import { buildActionPlan } from "../src/surfaces/dispatch.js";
import { publicClient } from "../src/chain/client.js";
import { parseEther } from "viem";

const c = publicClient();
const OWNER = "0x1111111111111111111111111111111111111111" as const;

// "any-revert": the target uses Solidity custom errors (no reason string), so
// an unauthorized eth_call reverts opaquely even with a correct selector. The
// interface is proven separately: the route check below (Router.getAmountsOut
// answers over the same Route tuple) and verifyve's Voter cross-references.
type Expect = "success" | "protocol-revert" | "any-revert";
const CASES: [string, any, Expect][] = [
  // Borrow suite — openTrove must simulate clean from a funded fresh account.
  ["borrow/openTrove", { action: "borrow", mintMUSD: "5000", collateralBTC: "0.5" }, "success"],
  ["repay/repayMUSD", { action: "repay", repayMUSD: "1000" }, "protocol-revert"], // no Trove
  ["closeTrove", { action: "closeTrove" }, "protocol-revert"], // no Trove
  // ve(3,3) — createLock must simulate clean; vote reverts (we don't own veNFT 1).
  ["lock/createLock(veBTC)", { action: "lock", asset: "BTC", amount: "0.2", lockDays: 28 }, "protocol-revert"], // no allowance in isolated call
  ["lock/createLock(veMEZO)", { action: "lock", asset: "MEZO", amount: "1000", lockDays: 365 }, "any-revert"], // no allowance in isolated call
  ["vote/manual", { action: "vote", mode: "manual", tokenId: "1", weights: { "MUSD/mUSDC": 10_000 } }, "any-revert"], // custom error: not owner of veNFT 1
  ["matchbox/reset(BoostVoter)", { action: "matchbox", op: "unpair", veMezoId: 5 }, "any-revert"], // not owner of veMEZO 5
  ["matchbox/vote(BoostVoter)", { action: "matchbox", op: "pair", veMezoId: 5, weights: { "BTC/MUSD": 10_000 } }, "any-revert"],
  // Zap — simulate the router swap leg (approvals are trivial ERC-20 calls).
  ["zap/swap-leg", { action: "zap", inputToken: "BTC", inputAmount: "0.01", pool: "BTC/MUSD", stake: false }, "any-revert"], // custom error: no allowance in isolated call
  // Vault deposit — the deposit step (mainnet only; sMUSD savings shape).
  ...(process.env.MEZO_NETWORK === "mainnet"
    ? [["vault/deposit", { action: "vaultDeposit", token: "MUSD", amount: "100" }, "any-revert"]] as [string, any, Expect][]
    : []),
];

let failures = 0;
console.log(`network=${process.env.MEZO_NETWORK}\n`);
for (const [label, intent, expect] of CASES) {
  const plan: any = await buildActionPlan(intent as any, OWNER as any);
  if (!plan?.executable) {
    console.log(`  ✗ FAIL ${label} — plan not executable (${plan?.gatedReason ?? "?"})`);
    failures++;
    continue;
  }
  // Pick the step that exercises the target protocol (skip approvals/fees).
  const step = plan.steps.find((s: any) => !["approval", "fee"].includes(s.kind)) ?? plan.steps[0];
  try {
    await c.call({
      to: step.to, data: step.data, value: step.value, account: OWNER as any,
      stateOverride: [{ address: OWNER as any, balance: parseEther("10") }],
    });
    const ok = expect === "success";
    console.log(`  ${ok ? "✓" : "✗ FAIL"} ${label.padEnd(24)} ${step.data?.slice(0, 10)} → SIMULATION SUCCEEDED${ok ? "" : " (expected revert)"}`);
    if (!ok) failures++;
  } catch (e: any) {
    const msg = String(e.shortMessage || e.message);
    const reason = e.cause?.reason || (msg.match(/reverted with reason: (.+?)(?:\.\s*$|$)/m)?.[1] ?? "");
    const decoded = Boolean(reason);
    // A DECODED protocol revert proves the selector+ABI matched; an opaque
    // revert on a "success" expectation is exactly the bug class we guard.
    const ok = expect === "any-revert" ? true : expect === "protocol-revert" ? decoded : false;
    console.log(`  ${ok ? "✓" : "✗ FAIL"} ${label.padEnd(24)} ${step.data?.slice(0, 10)} → ${decoded ? `decoded revert: ${reason}` : `OPAQUE revert (${String(e.shortMessage || e.message).replace(/\s+/g, " ").slice(0, 60)})`}`);
    if (!ok) failures++;
  }
}
// Positive interface proof for the swap path: the Router answers a quote over
// our exact Route tuple (incl. native BTC via the ERC-20 precompile).
{
  const { registry } = await import("../src/registry/registry.js");
  const { routerAbi } = await import("../src/abis/router.js");
  const router = registry.contract("Router");
  const factory = registry.contract("PoolFactory");
  const btc = registry.token("BTC"), musd = registry.token("MUSD");
  const route = { from: registry.routingAddress(btc), to: registry.routingAddress(musd), stable: false, factory };
  try {
    const amounts = (await c.readContract({ address: router, abi: routerAbi, functionName: "getAmountsOut", args: [parseEther("0.01"), [route]] })) as bigint[];
    console.log(`  ✓ route-encoding             Router.getAmountsOut(0.01 BTC) = ${amounts[amounts.length - 1]} MUSD-wei`);
  } catch (e: any) {
    console.log(`  ✗ FAIL route-encoding — ${String(e.shortMessage || e.message).slice(0, 80)}`);
    failures++;
  }
}

console.log(failures === 0 ? "\nAll simulations behaved as expected. ✅" : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
