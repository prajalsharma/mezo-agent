import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createWalletClient, http, parseEther, formatEther, formatUnits, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const { publicClient } = await import('../src/chain/client.js');
const { chainFor } = await import('../src/chain/networks.js');
const { registry } = await import('../src/registry/registry.js');
const { feeRouterAbi } = await import('../src/abis/router.js');
const { erc20Abi } = await import('../src/abis/erc20.js');

// E2E check: swaps 0.0005 BTC → MUSD through the FeeRouter with the DEPLOYER
// key and verifies the fee event + escrowless invariant. Testnet only.
// v1 proven live 2026-07-30: tx 0x24c69868d8d7e146638edd34566337bc2c57e3a520163d8020e09b5490cb5472
// v2 (adds feeBpsOverride for atomic zap fees) deployed at the address below.
const FEE_ROUTER = (process.env.FEE_ROUTER_ADDRESS ?? '0x16340c6a09d0383fe84f623f6c06885d5ce746a8') as Hex;
const pk = readFileSync(join(homedir(), '.mezo-agent-deploy/deployer.key'), 'utf8').trim() as Hex;
const account = privateKeyToAccount(pk);
const c = publicClient();
const chain = chainFor('testnet');
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

const BTC_PRE = '0x7b7C000000000000000000000000000000000000';
const MUSD = registry.token('MUSD').address;
const pool = registry.resolvePool('BTC','MUSD');
if (!pool) throw new Error('BTC/MUSD pool not in registry');
const factory = registry.contract('PoolFactory');
const route = { from: BTC_PRE as Hex, to: MUSD, stable: pool.stable, factory };
const amountIn = parseEther('0.0005');

const musdBefore = await c.readContract({ address: MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
console.log('deployer MUSD before:', formatUnits(musdBefore, 18));

// 1. approve FeeRouter on the BTC precompile
const gas1 = await c.estimateGas({ account: account.address, to: BTC_PRE, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FEE_ROUTER, amountIn] }) }).catch(() => 200000n);
const h1 = await wallet.sendTransaction({ to: BTC_PRE, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FEE_ROUTER, amountIn] }), gas: gas1 * 12n / 10n });
await c.waitForTransactionReceipt({ hash: h1, timeout: 120000, retryCount: 8 });
console.log('approve mined:', h1);

// 2. swapWithFee — atomic swap + fee in ONE tx
const data = encodeFunctionData({ abi: feeRouterAbi, functionName: 'swapWithFee', args: [amountIn, 0n, [route], BigInt(Math.floor(Date.now()/1000)+600), '0x0000000000000000000000000000000000000000', 0, 0] });
const simErr = await c.call({ account: account.address, to: FEE_ROUTER, data }).then(() => undefined, (e: Error & { shortMessage?: string }) => e.shortMessage || e.message);
if (simErr) { console.log('SIM FAILED:', simErr); process.exit(1); }
console.log('sim OK');
const h2 = await wallet.sendTransaction({ to: FEE_ROUTER, data, gas: 3000000n });
const r2 = await c.waitForTransactionReceipt({ hash: h2, timeout: 120000, retryCount: 8 });
console.log('swapWithFee mined:', h2, '| status:', r2.status, '| logs:', r2.logs.length);

const musdAfter = await c.readContract({ address: MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
console.log('deployer MUSD after :', formatUnits(musdAfter, 18), '| received:', formatUnits(musdAfter - musdBefore, 18));
const stuck = await c.readContract({ address: BTC_PRE, abi: erc20Abi, functionName: 'balanceOf', args: [FEE_ROUTER] }).catch(()=>0n);
console.log('BTC stuck in FeeRouter (must be 0):', formatEther(stuck));
