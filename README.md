# Mezo Agent — Telegram bot for the Mezo Bitcoin-DeFi stack

A conversational agent that lets a user operate the Mezo ecosystem (Borrow, Swap,
Earn, veBTC/veMEZO locking + voting, Matchbox, Market) in plain language, with
**every fund-moving action gated behind a simulated, human-readable confirmation.**

This repository is being built in phases. **This is Phase 1.**

## Phase 1 scope (this build)

| Feature | Status |
| --- | --- |
| Wallet creation (in-bot) | ✅ |
| Import existing account (opt-in, warned) | ✅ |
| Deposit address + scannable QR | ✅ |
| Live portfolio view (BTC + tokens) | ✅ |
| Telegram conversational UI | ✅ |
| DEX swap (quote → simulate → confirm → sign) | ✅ (token↔token; native-BTC route pending registry confirmation) |

Later phases add Borrow/Troves, zap-to-enter + LP staking, claim-all, locking &
voting, Matchbox pairing, Mezo Market, and the DCA / auto-convert keeper.

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
- Raw private-key **import is opt-in and warned**; the message containing the key
  is deleted immediately after it is sealed.

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

- **DEX Router address** is not yet published in the canonical reference; the swap
  builder targets the standard Velodrome-style Router V2 interface and reads the
  address from the registry. Token↔token swaps activate the moment the confirmed
  Router (+ PoolFactory) address is added; native-BTC routes additionally need the
  confirmed wrapped-native endpoint. The bot **refuses** to swap rather than invent
  an address.
- Datastore is a local JSON file (encrypted key material only). Production is
  Postgres + Redis.
- Custody is Tier 3 (see trust model). Non-custodial session keys are the target.
