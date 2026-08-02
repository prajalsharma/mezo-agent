export {};
// LIVE referral E2E: deployer swaps 100 MUSD→BTC via FeeRouter v3 with a
// referrer set. Verifies the referrer receives EXACTLY fee*30% on-chain.
import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
import { createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const { publicClient } = await import('../src/chain/client.js');
const { chainFor } = await import('../src/chain/networks.js');
const { registry } = await import('../src/registry/registry.js');
const { feeRouterAbi } = await import('../src/abis/router.js');
const { erc20Abi } = await import('../src/abis/erc20.js');

const FEE_ROUTER = '0xaa118fb3e071e6ba978af52b0cf531b316c4b8c9' as Hex;
const REFERRER = '0x9F1b0940387423290e069FE02d15d5B287d940B7' as Hex; // user's account as test referrer
const OPERATOR = '0x2B325c6768a11B2E7Cc9cF3EF8513A426677Bde9' as Hex; // deployer = trader AND operator recipient
const pk = readFileSync(join(homedir(), '.mezo-agent-deploy/deployer.key'), 'utf8').trim() as Hex;
const account = privateKeyToAccount(pk);
const c = publicClient(); const chain = chainFor('testnet');
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

const MUSD = registry.token('MUSD').address;
const pool = registry.resolvePool('BTC','MUSD')!;
const route = { from: MUSD, to: '0x7b7C000000000000000000000000000000000000' as Hex, stable: pool.stable, factory: registry.contract('PoolFactory') };
const amountIn = parseUnits('100', 18);

const refBefore = await c.readContract({ address: MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [REFERRER] }) as bigint;
console.log('referrer MUSD before:', formatUnits(refBefore, 18));

// approve FeeRouter for 100 MUSD
const a = await wallet.sendTransaction({ to: MUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FEE_ROUTER, amountIn] }), gas: 200000n });
await c.waitForTransactionReceipt({ hash: a, timeout: 120000, retryCount: 8 });
console.log('approve mined');

// swapWithFee: referred rate 45 bps override, referrer share 3000 (30% of fee)
const data = encodeFunctionData({ abi: feeRouterAbi, functionName: 'swapWithFee',
  args: [amountIn, 0n, [route], BigInt(Math.floor(Date.now()/1000)+600), REFERRER, 3000, 45] });
const h = await wallet.sendTransaction({ to: FEE_ROUTER, data, gas: 3000000n });
const r = await c.waitForTransactionReceipt({ hash: h, timeout: 120000, retryCount: 8 });
console.log('swapWithFee:', r.status, h);

const refAfter = await c.readContract({ address: MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [REFERRER] }) as bigint;
const got = refAfter - refBefore;
const expected = (amountIn * 45n / 10_000n) * 3000n / 10_000n; // fee 0.45 → 30% = 0.135
console.log('referrer received:', formatUnits(got, 18), 'MUSD | expected:', formatUnits(expected, 18), got === expected ? '✅ EXACT MATCH' : '❌ MISMATCH');
