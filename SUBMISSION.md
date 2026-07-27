# Mezo Conversational Agent — Submission Guide

A Telegram-delivered natural-language agent for the full Mezo Bitcoin-DeFi stack.
This document maps every bounty requirement to where it's implemented and how to
demo it, and states plainly what is live vs. execution-gated.

> **Architecture invariant (enforced everywhere):** *the LLM proposes; deterministic
> code disposes.* The model only emits a typed `Intent`; it never holds keys,
> builds calldata, invents addresses/amounts, or has final authority to move
> funds. Every value-moving action is built, **simulated**, confirmed, and signed
> by deterministic code within policy.

---

## 0. Run it in 90 seconds

```bash
npm install
cp .env.example .env
npm run genkey            # → MASTER_ENCRYPTION_KEY in .env
# add TELEGRAM_BOT_TOKEN (from @BotFather) to .env
npm run typecheck         # clean
npm run smoke             # custody invariants + live testnet read
npm run policycheck       # spending caps + TOCTOU
npm run phasecheck        # optimal voting, DCA, borrow/lock guards, multi-account, parser
npm run swapcheck         # live mainnet DEX quotes
npm run contracts:test    # SessionKeyDelegate (11 tests)
npm run dev               # start the bot (long-polling)
```

In Telegram: `/start` → Create/Import wallet → `/deposit` → `/portfolio` → try any
natural-language command below → `/help` for the full list.

---

## 1. Live vs. gated — read this first

Mezo's canonical contracts reference publishes addresses only for **tokens, the
PoolFactory, and the DEX pools**. Borrow, VotingEscrow, Voter, Matchbox, and
Market addresses are **not** published. Per the security rule *never invent an
address*, surfaces needing an unpublished address are **built end-to-end with real
fork calldata + simulation but execution-gated** — they activate by adding the
confirmed address to the registry (or via env), with **zero code change**.

| State | What it means | Examples |
| --- | --- | --- |
| ✅ **live** | Executes / computes today | Onboarding, portfolio, **swap/zap quotes**, spending limits, DCA scheduling, multi-account, optimal-voting math, custody |
| ✅ **gated** | Code-complete + tested; needs a confirmed address | Swap **execution** (`MEZO_ROUTER_ADDRESS`), Borrow, Lock, Vote, Claim, Market, Matchbox on-chain execution |

---

## 2. Requirement → implementation map

### Onboarding & funding
| Requirement | Where | Demo |
| --- | --- | --- |
| Create wallet in-bot | `src/wallet/walletService.ts` `createWallet` | `/start` → Create |
| Import (private key **or** BIP-39), opt-in + warned | `walletService.ts` `importWallet`, `deriveFromSecret` | `/start` → Import |
| Deposit address + QR | `src/bot/handlers/portfolio.ts` `handleDeposit` | `/deposit` |
| Live portfolio | `src/portfolio/portfolioService.ts` | `/portfolio` |

### Borrow (MUSD / Troves) — Phase 2
| Open Trove, min-net-debt 1800, MCR 110%, fee preview | `src/surfaces/borrow.ts` `buildBorrow` | `borrow 5000 MUSD against 0.1 BTC` |
| Repay / Adjust / Close | `buildRepay` / `buildAdjust` / `buildCloseTrove` | `repay 1000 MUSD` |
| Liquidation-risk warnings | `borrow.ts` (warnings array) | shown in confirmation |

### Swaps — Phase 1
| Live quote + slippage → min-out | `src/surfaces/swap/swapBuilder.ts` (pool `getAmountOut`) | `swap 100 MUSD to mUSDC` |
| Simulate-before-sign per step | `src/surfaces/swap/swapService.ts` | on confirm |

### Earn — Phase 2 & 4
| Vault deposit, Stake/Unstake LP | `src/surfaces/earn.ts` | `stake LP MUSD/mUSDC` |
| Zap-to-enter (split sized with live quote) + optional stake | `src/surfaces/zap.ts` `buildZap` | `zap 0.01 BTC into MUSD/mUSDC` |

### Claims — Phase 2
| Claim-all across surfaces | `src/surfaces/earn.ts` `buildClaim` | `claim all` |

### Locking & veNFTs — Phase 3 & 4
| Lock veBTC (1–28d) / veMEZO (≤4y), Extend | `src/surfaces/lock.ts` | `lock 0.2 BTC for 28 days` |
| Matchbox pairing | `src/surfaces/misc.ts` `buildMatchbox` | `pair veBTC 3 with veMEZO 7` |
| veNFT transfer / merge | `misc.ts` `buildVeTransfer` / `buildVeMerge` | `merge veNFT 3 into 7` |

### Voting — Phase 3
| Vote (manual + **optimal**) | `src/surfaces/vote.ts` | `vote optimally` |
| **Optimal algorithm** (transparent water-filling) | `src/core/optimalVoting.ts` | `npm run phasecheck` |

### Mezo Market — Phase 3
| Browse / buy | `src/surfaces/misc.ts` | `browse market` / `buy listing 42` |

### Bonus — Phase 5
| DCA (pre-authorized, scoped, revocable, idempotent) | `src/keeper/scheduler.ts` | `dca 50 MUSD to BTC every 24h` |
| Auto-compound preference | `src/bot/handlers/automation.ts` | `auto-compound on` |
| Spending limits / watch-only | `src/custody/policy.ts`, `src/custody/signer.ts` | `/limits`, `/watch` |
| Multi-account | `src/db/store.ts`, `walletService.ts` | `new account`, `switch to account 1` |

---

## 3. Security model (the heavily-weighted part)

| Requirement | Implementation |
| --- | --- |
| **Non-custodial / scoped delegation** | EIP-7702 session keys: `contracts/src/SessionKeyDelegate.sol` (on-chain per-tx/daily caps, allowlist, expiry, root-only management) + `src/custody/delegation.ts` + `src/chain/eip7702.ts` capability probe. `/upgrade`. |
| **No plaintext / no LLM exposure / no logs** | `src/custody/localKeystore.ts` (AES-256-GCM, no export path, buffer scrubbing). Verified by `npm run smoke`. |
| **Spending limits + confirmation thresholds** | Per-tx + rolling-24h native caps + opt-in per-token cap + step-up, enforced independently in the signer. `npm run policycheck`. |
| **Simulate before sign** | `src/core/simulator.ts` `eth_call` per step, immediately before signing. |
| **Explicit confirmation; scheduled = pre-authorized/scoped/revocable** | Generic confirm flow (`src/bot/handlers/actions.ts`); keeper runs within signer caps, `KEEPER_ENABLED` kill-switch. |
| **Slippage / MEV protection** | min-out from slippage in `swapBuilder.ts`. |
| **Never invent addresses/amounts** | `src/registry/` is the only address source; surfaces gate rather than invent. |
| **Defense in depth** | App policy → signer re-check → on-chain delegate. |

**Trust model:** Phase-1 default is Tier-3 contained-custodial (AES at rest under
`MASTER_ENCRYPTION_KEY`, host-held). `/upgrade` moves to EIP-7702 semi-custodial
(scoped session key, on-chain-bounded). Full non-custodial (user-held root) reuses
the same seams. Documented in README §"Trust model".

---

## 4. Testing

| Suite | Covers |
| --- | --- |
| `npm run smoke` | keystore round-trip, no-plaintext, fail-closed, BIP-39 derivation |
| `npm run policycheck` | per-tx/daily caps, allowlist, watch-only, ERC-20 cap, TOCTOU reserve/release |
| `npm run phasecheck` | optimal-voting properties, DCA idempotency, borrow/lock guardrails, multi-account, parser routing |
| `npm run swapcheck` | live mainnet quotes from real pools |
| `npm run contracts:test` | SessionKeyDelegate (caps, expiry, allowlist, access control, + audit regressions) — 16 tests |

**Security audit:** the on-chain delegate went through a 12-agent adversarial
audit (Pashov `solidity-auditor`). A critical self-call privilege-escalation and a
high stale-allowlist bug were found, **fixed, and regression-tested**; two
design-level items (native-value-only caps, fixed-window bound) are documented.
See **[AUDIT.md](AUDIT.md)**.

**Edge cases documented/handled:** min-net-debt, lock-duration caps, unknown
token/pool, over-cap spend, watch-only, expired session, DCA occurrence limits,
gated-address refusal, RPC fallback.

---

## 5. Deliverables status

- **GitHub repo** — this repo, branch `phase-1`.
- **README** — setup, trust model, phase status, maintenance plan.
- **Live Testnet** — onboarding/portfolio/limits run on Matsnet; swap quotes on mainnet (pools are mainnet-only).
- **Mainnet** — contingent on security review + Mezo publishing the remaining addresses.
- **Maintenance plan** — README §13 (6-month commitment, registry-driven ABI updates, monetization).

---

## 6. Monetization (disclosed in-bot)

A small, transparently-shown fee on swaps/zaps; automation (DCA, auto-compound) as
an opt-in subscription. Users see the fee before confirming. (Fee hook is a
one-line addition in `swapBuilder.ts` once a fee recipient is set.)
