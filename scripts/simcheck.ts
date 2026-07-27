import "./_testenv.js";
import { buildActionPlan } from "../src/surfaces/dispatch.js";
import { publicClient } from "../src/chain/client.js";
import { parseEther } from "viem";
const c = publicClient();
const OWNER = "0x1111111111111111111111111111111111111111" as const;
console.log(`network=${process.env.MEZO_NETWORK}`);
for (const [label, intent] of [
  ["openTrove", { action: "borrow", mintMUSD: "5000", collateralBTC: "0.5" }],
  ["repayMUSD", { action: "repay", repayMUSD: "1000" }],
  ["closeTrove", { action: "closeTrove" }],
] as const) {
  const plan: any = await buildActionPlan(intent as any, OWNER as any);
  const s = plan.steps[plan.steps.length - 1];
  try {
    await c.call({
      to: s.to, data: s.data, value: s.value, account: OWNER as any,
      stateOverride: [{ address: OWNER as any, balance: parseEther("10") }],
    });
    console.log(`  ${label.padEnd(11)} selector=${s.data.slice(0,10)} → SIMULATION SUCCEEDED`);
  } catch (e: any) {
    const raw = e.cause?.reason || e.shortMessage || e.message;
    console.log(`  ${label.padEnd(11)} selector=${s.data.slice(0,10)} → revert: ${String(raw).replace(/\s+/g," ").slice(0, 130)}`);
  }
}
