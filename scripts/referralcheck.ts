/** Referral split-at-source: discount, split ordering, ledger. (Legacy path — no FeeRouter set.) */
process.env.AGENT_FEE_BPS = "50";
process.env.AGENT_FEE_RECIPIENT = "0x00000000000000000000000000000000000000fe";
process.env.AGENT_REFERRAL_SHARE_PCT = "30";
process.env.MEZO_NETWORK = "mainnet";
// Dynamic imports so the env assignments above take effect BEFORE env.ts caches
// its config (static imports hoist above the assignments).
await import("./_testenv.js");
const { buildSwap } = await import("../src/surfaces/swap/swapBuilder.js");
const { registry } = await import("../src/registry/registry.js");
const { store } = await import("../src/db/store.js");
let fail = 0; const ok = (n: string, c: boolean) => { console.log(`  ${c ? "\u2713" : "\u2717 FAIL"} ${n}`); if (!c) fail++; };
const referrer = "0x1111111111111111111111111111111111111111" as const;
const trader = "0x2222222222222222222222222222222222222222" as const;
const tin = registry.token("MUSD"), tout = registry.token("mUSDC");
const plan: any = await buildSwap({ owner: trader as any, tokenIn: tin, tokenOut: tout, humanAmountIn: "100", slippagePct: 0.5, referral: { recipient: referrer as any, sharePct: 30, referrerTelegramId: 999 } });

// Referred users pay the DISCOUNTED rate: 45 bps (90% of 50) -> fee 0.45 MUSD.
const referredFee = (100n * 10n ** 18n * 45n) / 10_000n;
ok("referred user pays the discounted 45 bps", plan.fee?.bps === 45 && plan.fee?.amount === referredFee);

// Legacy split: operator "fee" step FIRST, "referral" step LAST (a referral
// failure must never cost the operator's cut — audit ordering fix).
const kinds = plan.steps.map((s: any) => s.kind).filter((k: string) => k === "fee" || k === "referral");
ok('split steps ordered ["fee","referral"]', JSON.stringify(kinds) === JSON.stringify(["fee", "referral"]));

// Amounts: 30% of the 0.45 fee -> 0.135 to referrer; 0.315 to operator.
const expectRef = (referredFee * 30n) / 100n;
ok("referralPaid == 30% of the discounted fee", plan.referralPaid?.amount === expectRef);
ok("referralPaid carries referrerTelegramId", plan.referralPaid?.referrerTelegramId === 999);
const refStep = plan.steps.find((s: any) => s.kind === "referral");
const opStep = plan.steps.find((s: any) => s.kind === "fee");
ok("operator + referrer cuts sum to the fee", refStep && opStep && (refStep.erc20.amount + opStep.erc20.amount) === referredFee);

// No-referral case: full 50 bps, single operator fee step, no referral step.
const plan2: any = await buildSwap({ owner: trader as any, tokenIn: tin, tokenOut: tout, humanAmountIn: "100", slippagePct: 0.5 });
ok("no referral -> full 50 bps", plan2.fee?.bps === 50);
ok("no referral -> single fee step, no referral step", plan2.steps.filter((s: any) => s.kind === "fee").length === 1 && !plan2.steps.some((s: any) => s.kind === "referral") && !plan2.referralPaid);

// Ledger round-trip.
store.recordReferralEarning(999, "MUSD", expectRef);
ok("ledger records the earning", store.referralEarnings(999).byToken.MUSD === expectRef.toString());

// Pending-referral persistence (survives restart by living in the store).
store.setPendingReferral(424242, 999, 60_000);
ok("pending referral persisted + peekable", store.peekPendingReferral(424242) === 999);
ok("peek does not consume", store.peekPendingReferral(424242) === 999);
store.clearPendingReferral(424242);
ok("clear removes it", store.peekPendingReferral(424242) === undefined);

console.log(fail === 0 ? "\nAll referral checks passed. \u2705" : `\n${fail} FAILURE(S) \u2717`);
process.exit(fail === 0 ? 0 : 1);
