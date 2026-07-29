/** Referral split-at-source: fee splits to referrer + operator; ledger records it. */
process.env.AGENT_FEE_BPS = "50";
process.env.AGENT_FEE_RECIPIENT = "0x00000000000000000000000000000000000000fe";
process.env.AGENT_REFERRAL_SHARE_PCT = "30";
process.env.MEZO_NETWORK = "mainnet";
import "./_testenv.js";
import { buildSwap } from "../src/surfaces/swap/swapBuilder.js";
import { registry } from "../src/registry/registry.js";
import { store } from "../src/db/store.js";
let fail = 0; const ok = (n: string, c: boolean) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${n}`); if (!c) fail++; };
const referrer = "0x1111111111111111111111111111111111111111" as const;
const trader = "0x2222222222222222222222222222222222222222" as const;
const tin = registry.token("MUSD"), tout = registry.token("mUSDC");
const plan: any = await buildSwap({ owner: trader as any, tokenIn: tin, tokenOut: tout, humanAmountIn: "100", slippagePct: 0.5, referral: { recipient: referrer as any, sharePct: 30 } });
const feeSteps = plan.steps.filter((s: any) => s.kind === "fee");
ok("two fee steps (referrer + operator)", feeSteps.length === 2);
ok("referralPaid present with 30% of fee", plan.referralPaid && plan.referralPaid.amount > 0n);
// fee = 100 MUSD * 0.5% = 0.5 MUSD; 30% = 0.15 MUSD (18dp)
const expectRef = (100n * 10n**18n * 50n / 10000n) * 30n / 100n;
ok("referrer cut == 30% of fee exactly", plan.referralPaid.amount === expectRef);
// no-referral case: single fee step
const plan2: any = await buildSwap({ owner: trader as any, tokenIn: tin, tokenOut: tout, humanAmountIn: "100", slippagePct: 0.5 });
ok("no referral → single fee step", plan2.steps.filter((s:any)=>s.kind==="fee").length === 1 && !plan2.referralPaid);
// ledger
store.recordReferralEarning(999, "MUSD", expectRef);
ok("ledger records the earning", store.referralEarnings(999).byToken.MUSD === expectRef.toString());
console.log(fail===0?"\nAll referral checks passed. ✅":`\n${fail} FAILURE(S) ✗`);
process.exit(fail===0?0:1);
