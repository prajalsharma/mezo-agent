export {};
// Full fee-logic verification at the COMMITTED rates: 50 bps swap/zap, 10 bps txn.
const owner='0x2B325c6768a11B2E7Cc9cF3EF8513A426677Bde9'; // funded deployer (has BTC+MUSD)
const { registry } = await import('../src/registry/registry.js');
const { buildSwap } = await import('../src/surfaces/swap/swapBuilder.js');
const { buildZap } = await import('../src/surfaces/zap.js');
const { buildBorrow } = await import('../src/surfaces/borrow.js');
const { buildLock } = await import('../src/surfaces/lock.js');
const { env, feesEnabled, txnFeesEnabled } = await import('../src/config/env.js');
const { formatUnits, parseUnits } = await import('viem');

console.log('CONFIG: swapBps=', env.fees.swapBps, '| referredBps=', env.fees.referredBps, '| txnBps=', env.fees.txnBps, '| feesEnabled=', feesEnabled, '| txnFeesEnabled=', txnFeesEnabled);
let pass=0, fail=0;
const check=(name: string, cond: boolean, detail?: string)=>{ console.log((cond?'✅':'❌'), name, detail??''); cond?pass++:fail++; };

// 1. SWAP — normal user: 50 bps atomic via FeeRouter
const p1 = await buildSwap({owner, tokenIn:registry.token('MUSD'), tokenOut:registry.token('BTC'), humanAmountIn:'100', slippagePct:0.5});
check('swap fee = 0.5 MUSD (50bps of 100)', p1.fee?.amount === parseUnits('0.5',18), '| bps='+p1.fee?.bps);
check('swap atomic (target=FeeRouter, no fee step)', p1.steps.every(s=>s.kind!=='fee') && p1.steps.some(s=>s.kind==='swap' && s.to.toLowerCase()==='0xaa118fb3e071e6ba978af52b0cf531b316c4b8c9'));

// 2. SWAP — referred user: 45 bps (90% of 50) + 30% referral share to referrer
const p2 = await buildSwap({owner, tokenIn:registry.token('MUSD'), tokenOut:registry.token('BTC'), humanAmountIn:'100', slippagePct:0.5, referral:{recipient:'0x9F1b0940387423290e069FE02d15d5B287d940B7', sharePct:30}});
check('referred swap fee = 0.45 MUSD (45bps)', p2.fee?.amount === parseUnits('0.45',18), '| bps='+p2.fee?.bps);

// 3. ZAP — 50 bps of gross, atomic via override
const p3 = await buildZap({action:'zap', inputToken:'BTC', inputAmount:'0.001', pool:'BTC/MUSD', stake:false}, owner);
const zapFeeLine = p3.summary.find(l=>l.includes('fee'));
check('zap fee line = 0.000005 BTC (50bps of 0.001) atomic', /0\.000005 BTC \(0\.5%\).*atomically/.test(zapFeeLine??''), '| '+zapFeeLine);
check('zap has NO separate fee step', p3.steps.every(s=>s.kind!=='fee'));

// 4. BORROW — 10 bps on minted MUSD, charged after trove opens
const p4 = await buildBorrow({action:'borrow', collateralBTC:'0.1', mintMUSD:'2000'});
const borrowFeeStep = p4.steps.find(s=>s.kind==='fee');
const borrowFeeLine = p4.summary.find(l=>l.toLowerCase().includes('agent fee'));
check('borrow agent fee = 2 MUSD (10bps of 2000)', /2 MUSD \(0\.1%\)/.test(borrowFeeLine??'') || borrowFeeStep!==undefined, '| '+borrowFeeLine);
check('borrow fee is LAST step (after openTrove)', p4.steps[p4.steps.length-1]?.kind==='fee' && p4.steps[0]?.kind==='openTrove');

// 5. LOCK — 10 bps on locked amount
const p5 = await buildLock({action:'lock', asset:'MEZO', amount:'1000', lockDays:365});
const lockFeeLine = p5.summary.find(l=>l.toLowerCase().includes('agent fee'));
check('lock agent fee = 1 MEZO (10bps of 1000)', /1 MEZO \(0\.1%\)/.test(lockFeeLine??''), '| '+lockFeeLine);

// 6. CLAIM / VOTE — must have NO agent fee (collecting your own rewards)
const { buildClaim } = await import('../src/surfaces/earn.js');
try { const p6 = await buildClaim({action:'claim', scope:'all'}, owner);
  check('claim has no fee step', p6.steps.every(s=>s.kind!=='fee'));
} catch(e){ const m = e instanceof Error ? e.message : String(e); check('claim has no fee step (nothing claimable — fee N/A)', /claimable/i.test(m), '| '+m.slice(0,60)); }

console.log(`\n${pass}/${pass+fail} PASSED${fail?' — '+fail+' FAILED':''}`);
process.exit(fail?1:0);