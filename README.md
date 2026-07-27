# Mezo Agent — Telegram bot for the Mezo Bitcoin-DeFi stack

A conversational agent that lets a user operate the Mezo ecosystem (Borrow, Swap,
Earn, veBTC/veMEZO locking + voting, Matchbox, Market) in plain language, with
**every fund-moving action gated behind a simulated, human-readable confirmation.**

This repository is built in phases. **Phases 1–5 are implemented.**

> **How to read "status" below.** Mezo has published addresses only for tokens,
> the PoolFactory, and the DEX pools. Borrow, VotingEscrow, Voter, Matchbox and
> Market addresses are **not** in the canonical reference yet. Per the security
> rule *never invent an address*, every surface that needs an unpublished address
> is built end-to-end (typed intent → validate → **build real calldata** →
> simulate → confirm → sign) but **execution-gated** until the address is set in
> the registry (via env). Pure-logic features (optimal voting, DCA scheduling,
> multi-account) are fully live and unit-tested. "✅ live" = works today; "✅
> gated" = code-complete + tested, activates when the address lands.

## Phase 1 scope

| Feature | Status |
| --- | --- |
| Wallet creation (in-bot) | ✅ |
| Import existing account — private key **or** BIP-39 seed phrase (opt-in, warned) | ✅ |
| Deposit address + scannable QR | ✅ |
| Live portfolio view (BTC + tokens) | ✅ |
| Telegram conversational UI | ✅ |
| DEX swap — live quote → simulate → confirm → sign | ✅ live quotes (token↔token **and** native BTC, read from pool reserves); execution enabled by setting the confirmed `MEZO_ROUTER_ADDRESS` |
| Spending limits (per-tx + rolling 24h cap) & watch-only mode | ✅ enforced in the signer (`/limits`, `/watch`) |
| Health self-test | ✅ `/diag` |

## Phases 2–5 scope

| Phase | Feature | Status |
| --- | --- | --- |
| **2** | Borrow (open Trove) — min-net-debt + MCR guardrails, borrowing-fee preview | ✅ gated (Liquity ABI) |
| 2 | Repay / Adjust / Close Trove | ✅ gated |
| 2 | Vault deposit · Stake / Unstake LP · Claim rewards | ✅ gated |
| **3** | Lock veBTC (1–28d) / veMEZO (≤4y), Extend | ✅ gated (VotingEscrow ABI) |
| 3 | Vote — **optimal** (water-filling) + manual | ✅ optimizer live & tested; on-chain vote gated |
| 3 | Mezo Market — browse / buy | ✅ gated |
| **4** | Zap-to-enter (single asset → LP, optional stake) | ✅ split quoted live; execution gated |
| 4 | Matchbox pairing · veNFT transfer / merge | ✅ gated |
| **5** | DCA schedules (pre-authorized, scoped, revocable) | ✅ **live** (scheduler + keeper, unit-tested) |
| 5 | Auto-compound preference · Multi-account | ✅ **live** |
| 5 | Optimal-voting algorithm (transparent, documented) | ✅ **live** (`src/core/optimalVoting.ts`) |

**Throughout (not deferred):** session-key custody (EIP-7702), simulate-before-sign
on every step, explicit confirmation + step-up, the three-layer security model, and
tests (`smoke`, `policycheck`, `phasecheck`, `swapcheck`, `contracts:test`).

The natural-language parser understands all of the above (LLM path + a
deterministic fallback that needs no model vendor). Every fund-moving action —
manual or scheduled — passes through the same signer caps/allowlist, so a
schedule can never exceed what a manual action could.

### Enabling gated surfaces

Each gated surface activates by adding its confirmed address to the registry
(`src/registry/addresses.ts`) or via env — no code change. For example, set
`MEZO_ROUTER_ADDRESS` for swap/zap execution, or add `BorrowerOperations`,
`HintHelpers`, `SortedTroves`, `PriceFeed` for live Borrow. The bot refuses to
act against an unconfirmed address rather than invent one.

## The core invariant

> **The LLM proposes; deterministic code disposes.**

The language model is only a **parser**: it turns a message into a typed `Intent`
(see `src/llm/intent.ts`). It never holds keys, never produces calldata, never
invents addresses or amounts, and never has final authority to move funds.
Everything that can move value is built, validated, simulated, and executed by
deterministic code (`src/surfaces/…`, `src/custody/…`) and gated by an explicit
user confirmation.

Four rules follow from this and are enforced architecturally:

1. **Secrets never cross the reasoning boundary.** No key/seed is ever sent to an
   LLM, written to a log, or stored in plaintext. Key material is touched only by
   the `KeyStore` (`src/custody/`).
2. **Simulate before sign.** Every state-changing tx is dry-run with `eth_call`
   and decoded before the user confirms, and again immediately before signing.
3. **Addresses come from a registry, never the model.** All addresses are read
   from `src/registry/` (seeded from Mezo's canonical contracts reference).
4. **Defense in depth.** Confirmation happens at the app layer (user taps
   Confirm), and the signer independently re-checks policy (allowlisted targets,
   watch-only mode) before signing.

## Trust model (read this)

Phase 1 uses a **Tier 3 "contained-custodial"** account, which is the fallback in
the tiered custody design:

- A key is generated in-bot and **encrypted at rest with AES-256-GCM**
  (`src/custody/localKeystore.ts`). It is **never** stored in plaintext, logged,
  or sent to any LLM provider. The stored record holds only the ciphertext, IV,
  and auth tag.
- The plaintext key exists only transiently inside a `keystore.use(...)` callback
  during signing, and the buffer is scrubbed afterward.
- Raw **import is opt-in and warned** and accepts either a private key or a BIP-39
  seed phrase (12–24 words); the message containing the secret is deleted
  immediately after it is sealed, and the plaintext never leaves the import
  function.
- **Spending limits are enforced in the signer**, not just the UI: a per-transaction
  native-BTC cap and a rolling 24h cap (defaults 0.05 / 0.2 BTC, tunable via
  `/limits`), plus a **watch-only** mode (`/watch on`) that blocks all signing. So
  even a compromised session cannot exceed these caps. (Per-token USD caps arrive
  with the price-feed integration in a later phase — documented, not hidden.)

**What the operator can/cannot do, and host-compromise blast radius:** with the
Tier 3 model, a compromised host that also has `MASTER_ENCRYPTION_KEY` could sign
for users — which is exactly why this is a *stopgap for local development*, not
the mainnet custody model.

> ⚠️ **Application-level encryption alone is NOT acceptable for mainnet.** The
> production target is **non-custodial, scoped, revocable delegation** — a smart
> account with an on-chain session-key module (ERC-7579/4337) or EIP-7702
> delegation, where the agent holds only a narrowly-scoped, time-bound,
> revocable permission and the user keeps custody. The `KeyStore` interface
> (`src/custody/keystore.ts`) is deliberately narrow so the Phase 1 AES store is
> replaced by a KMS/HSM/MPC signer with **no change to callers**. Whether Mezo
> exposes a canonical EntryPoint/bundler or accepts 7702 is a week-one capability
> probe that selects the primary tier.

## Architecture map

```
src/
  config/env.ts            validated env, single source of config
  chain/                   Mezo network params (from canonical docs) + read client
  registry/                ContractRegistry — the ONLY source of addresses
  abis/                    ERC-20 + Velodrome-style Router V2 ABIs
  custody/
    keystore.ts            KeyStore interface (no plaintext export by design)
    localKeystore.ts       AES-256-GCM at rest (Tier 3 stopgap; KMS-swappable)
    signer.ts              isolated writer; re-checks policy; key never escapes
  wallet/walletService.ts  create / import (opt-in) onboarding
  portfolio/               read path — balances (separate from write path)
  core/simulator.ts        eth_call dry-run + revert decoding
  surfaces/swap/           deterministic swap builder + executor
  llm/                     provider-agnostic intent parser + typed Intent schema
  db/store.ts              Phase 1 file store (Postgres/Redis-swappable)
  bot/                     grammY UI, handlers, pending-confirmation session
```

## Setup

```bash
npm install
cp .env.example .env
npm run genkey          # prints a 32-byte key → put it in MASTER_ENCRYPTION_KEY
# create a bot with @BotFather → put the token in TELEGRAM_BOT_TOKEN
# keep MEZO_NETWORK=testnet for development
npm run smoke           # verifies custody + a live testnet portfolio read
npm run dev             # starts the bot (long-polling)
```

`ANTHROPIC_API_KEY` is optional — without it, the bot uses a deterministic regex
parser (`swap <amount> <TOKEN> to <TOKEN>`), so it is fully usable with no model
vendor. The LLM layer is provider-agnostic (`src/llm/adapter.ts`).

## Verifying it works

`npm run smoke` (no Telegram token needed) checks:

1. keystore seal→use round-trip returns the original key and the sealed blob
   contains no plaintext;
2. wallet creation persists an encrypted record with no plaintext key field;
3. a live balance read against `https://rpc.test.mezo.org`;
4. deterministic intent parsing, including the "never invent an unknown token"
   guardrail.

## Network details (from the canonical docs)

| | Testnet (Matsnet) | Mainnet |
| --- | --- | --- |
| Chain ID | 31611 | 31612 |
| RPC | `https://rpc.test.mezo.org` | `https://rpc_evm-mezo.imperator.co` |
| Explorer | `https://explorer.test.mezo.org` | `https://explorer.mezo.org` |
| Gas asset | BTC (18 decimals) | BTC (18 decimals) |

Testnet BTC/MEZO faucet: https://faucet.test.mezo.org/

## Known Phase 1 limitations (tracked, not hidden)

- **Swap quoting is LIVE** — read directly from each pool's on-chain reserves
  (`getAmountOut`), so real quotes (token↔token and native BTC) work today on
  mainnet, with slippage → min-out. The registry is seeded with the canonical
  tokens, `PoolFactory`, and the confirmed BTC/MUSD, MUSD/mUSDC, MUSD/mUSDT pools.
- **DEX Router address** is not yet published in the canonical reference, so
  on-chain swap *execution* is gated: set `MEZO_ROUTER_ADDRESS` to the confirmed
  Router to enable atomic `approve → swapExactTokensForTokens`. Native-BTC swap
  execution additionally awaits the confirmed native-swap entrypoint. The bot
  **refuses to execute** (but still shows the live quote) rather than invent an
  address. Verify with `npm run swapcheck`.
- **Spending safety:** the confirmation step-up (a second high-value confirm above
  the per-user threshold) is enforced in the swap flow; the daily-cap accounting
  reserves value *before* submit and releases on failure (closing a TOCTOU
  window); an opt-in per-token ERC-20 cap is enforced in the signer. Verify with
  `npm run policycheck`.
- Datastore is a local JSON file (encrypted key material only). Production is
  Postgres + Redis.
- Custody is Tier 3 (see trust model). **Custody roadmap:** Tier 3 (app-level
  AES) is a deliberate Phase-1 stopgap; the committed mainnet target is Tier 1 —
  a smart account with an on-chain session-key module (ERC-7579/4337) or EIP-7702
  delegation, where the user keeps custody and the agent holds only a scoped,
  revocable permission. The `KeyStore` interface is built for that swap.
  **Status:** the EIP-7702 path is now implemented as a first step (semi-custodial
  "Option A"). Mezo mainnet accepts type-`0x04` set-code transactions (Prague is
  active). `contracts/SessionKeyDelegate.sol` is the on-chain session-key delegate
  (allowlist + per-tx / rolling-24h caps + expiry, enforced on-chain and root-only
  to manage); `/upgrade` has the root self-sign the authorization and register a
  scoped session key, after which routine ops are signed by the session key via
  `signer.ts`. The root key still lives in the app-level store in this step (hence
  *semi*-custodial); moving root custody to the user (fully non-custodial "Option
  B") reuses the same delegate and signer seams. The delegate is unaudited and
  must be deployed + registered per network before `/upgrade` is available —
  see `contracts/README.md`.
- Spending caps bind **native BTC** value plus an opt-in raw per-token cap;
  true USD-denominated caps come with the price feed. Seed-phrase import uses the
  standard EVM path `m/44'/60'/0'/0/0` (account 0).
- The `SessionKeyDelegate` contract now has a passing Foundry test suite
  (`npm run contracts:test`, 11 tests). Deploy it with
  `contracts/script/Deploy.s.sol` and set `DELEGATE7702_ADDRESS` to enable
  `/upgrade`. It remains unaudited pending the security review.
