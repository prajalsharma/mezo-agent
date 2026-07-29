# Mezo Agent — Telegram bot for the Mezo Bitcoin-DeFi stack

A conversational agent that lets a user operate the Mezo ecosystem (Borrow, Swap,
Earn, veBTC/veMEZO locking + voting, Matchbox, Market) in plain language, with
**every fund-moving action gated behind a simulated, human-readable confirmation.**

This repository is built in phases. **Phases 1–5 are implemented.**

> **How to read "status" below.** Every wired address comes from Mezo's own
> docs (contracts reference, MUSD developer reference, mezo-pools developer
> page) and is **verified on-chain before use** (`npm run verifyaddrs`,
> `npm run verifyve`). Per the security rule *never invent an address*, the few
> surfaces whose contracts remain unpublished (veMEZO escrow, Matchbox, Market)
> are built end-to-end but **execution-gated** until their address lands (via
> `MEZO_ADDR_*` env). Everything else executes on both networks.

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

"Status" below means **executability**, not "code written". Run
`npm run phaseaudit` to reproduce this table against the live registry — it
builds every surface and reports whether it can sign or is preview-only and why.
A surface is preview-only when its contract address is not published in the
canonical reference; nothing here is gated by missing code.

| Phase | Feature | Status |
| --- | --- | --- |
| **2** | Borrow (open Trove) — min-net-debt + MCR guardrails, borrowing-fee preview | ✅ **executable** (simulated on testnet + mainnet) |
| 2 | Repay / Adjust / Close Trove | ✅ **executable** |
| 2 | Stake / Unstake LP · Claim gauge earnings | ✅ **executable** (gauge from Voter, live) |
| 2 | Vault deposit | 🔒 preview (ERC-4626 wiring pending) |
| **3** | Lock veBTC (1–28d), Extend | ✅ **executable** (via BTC ERC-20 precompile) |
| 3 | Lock veMEZO (≤4y) | 🔒 preview (escrow unpublished) |
| 3 | Vote — manual weights | ✅ **executable** (Voter.vote) |
| 3 | Vote — **optimal** (water-filling) | ✅ optimizer live & tested; needs incentives indexer |
| 3 | Mezo Market — browse / buy | 🔒 preview (no published contract) |
| **4** | Zap-to-enter (single asset → LP) | ✅ **executable** (swap + addLiquidity, slippage-floored) |
| 4 | veNFT transfer / merge | ✅ **executable** |
| 4 | Matchbox pairing | 🔒 preview (community project) |
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

### Address provenance and verification

Addresses are read from the canonical reference, never hardcoded from memory:

- **Borrow** (`BorrowerOperations`, `TroveManager`, `HintHelpers`, `SortedTroves`,
  `PriceFeed`) — from the MUSD developer reference, then **verified on-chain** by
  `npm run verifyaddrs`: each has deployed code, answers its own interface, and
  all five cross-references agree (`BorrowerOperations.troveManager ==
  TroveManager`, `TroveManager.borrowerOperations == BorrowerOperations`, and so
  on). `BorrowerOperations.musd()` also matches the MUSD token in the registry.
  Cross-referencing is the part that distinguishes "code exists here" from "this
  is the live, linked deployment".
- **DEX pools / PoolFactory** — from the contracts reference, verified live
  (`getAmountOut` returns non-zero, `factory()` matches).
- **Router** — from `docs/developers/features/mezo-pools.md`, verified on-chain
  (`Router.factory == PoolFactory`; `getAmountsOut` answers over our routes).
- **ve(3,3) suite** (`VotingEscrowBTC`, `Voter`, `RewardsDistributor`) — the
  docs page lists a deployment that is a **stale ghost on mainnet** (its VeBTC
  holds 0.00096 BTC; its Voter has zero gauges). The production system was
  found by following the official docs' ValidatorsVoter (validator-gauge.md):
  `ValidatorsVoter.ve()` → the live VeBTC (**824.7 BTC locked**) → `voter()` →
  the live Voter (**26 gauges**, including every registry pool). `npm run
  verifyve` re-proves the full linkage on every run and now asserts
  **liveness** (locked supply > 0, gauges > 0) so a ghost deployment can never
  pass again. Testnet's documented deployment IS the live one (16/16). This is
  the "do not hardcode stale values" requirement biting in the wild: the doc
  value itself was stale, and on-chain linkage + usage decided.
- **VotingEscrowMEZO, Matchbox, Market** — genuinely unpublished: veMEZO has no
  documented contract, Matchbox is an external community project
  (matchbox.markets), and Mezo Market has no published contract. These stay
  preview-only rather than guessing. (`PoolFactory.voter()` resolving to a
  Gnosis Safe 5-of-N is the admin, not the ve(3,3) Voter — the real Voter came
  from the docs page and proved itself via the cross-references above.)

> A signature mismatch found this way: Mezo's MUSD fork drops Liquity's leading
> `_maxFeePercentage` argument from `openTrove` and `withdrawMUSD`. The upstream
> 4-argument form encodes a selector no function matches, so it reverts with **no
> reason string** — indistinguishable at a glance from a collateral or balance
> problem. Simulation caught it: a correct selector produces a decoded protocol
> revert. `npm run simcheck` is the regression guard.

### Enabling gated surfaces — feature → env key

Every surface activates by supplying its confirmed contract address via env —
no code change. The bot refuses to act against an unconfirmed address rather
than invent one. `npm run phaseaudit` prints this table live for the configured
network.

| Feature | Status today | Env key (override) |
| --- | --- | --- |
| Wallet / portfolio / deposit QR | ✅ live | — |
| Borrow / Repay / Adjust / Close Trove | ✅ **executable** (verified + simulated, both networks) | `MEZO_ADDR_BORROWEROPERATIONS` … |
| Swap quotes + **execution** (incl. native BTC via precompile) | ✅ **executable** | `MEZO_ADDR_ROUTER` |
| Zap into pool (single asset → LP) | ✅ **executable** (pool-member input; multi-hop preview) | `MEZO_ADDR_ROUTER` |
| Stake / Unstake LP | ✅ **executable** — gauge resolved live from Voter¹ | `MEZO_ADDR_VOTER` |
| Claim gauge earnings | ✅ **executable** (enumerates gauges, claims where earned > 0)¹ | `MEZO_ADDR_VOTER` |
| Claim rebases / bribes | 🔒 preview — needs veNFT enumeration (indexer) | `MEZO_ADDR_REWARDSDISTRIBUTOR` |
| Vote — manual weights | ✅ **executable** (`vote with veNFT <id>: 60% MUSD/mUSDC …`) | `MEZO_ADDR_VOTER` |
| Vote — optimal | 🔒 preview — optimizer live, needs the incentives indexer | — |
| Lock veBTC / extend / veNFT transfer & merge | ✅ **executable** (BTC via ERC-20 precompile) | `MEZO_ADDR_VOTINGESCROWBTC` |
| Lock veMEZO | 🔒 preview — escrow address genuinely unpublished | `MEZO_ADDR_VOTINGESCROWMEZO` |
| Matchbox pairing | 🔒 preview — community project, external contracts | `MEZO_ADDR_MATCHBOX` |
| Mezo Market browse / buy | 🔒 preview — no published contract | `MEZO_ADDR_MARKET` |
| Vault deposits | 🔒 preview — vault addresses published but ERC-4626 wiring pending | — |
| EIP-7702 `/upgrade` (session keys) | 🔒 preview | `DELEGATE7702_ADDRESS` (deploy `contracts/` first) |
| DCA / auto-compound scheduling | ✅ live — trades land now that the Router is wired | `KEEPER_ENABLED=true` |
| Multi-account, limits, watch-only, optimal-voting math | ✅ live | — |

¹ Live on **both networks** — testnet Voter has 4 gauges, mainnet Voter has 26
(gauges exist for all three registry pools; resolved live per action, never
hardcoded).

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

Keep the bot token out of the repo and out of shell history by supplying it
per-shell instead of writing it to `.env`:

```bash
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN && npm start
```

### Access control

A Telegram bot has no unlisted mode: anyone who learns the username can message
it. `TELEGRAM_ALLOWED_USER_IDS` (comma-separated) restricts the bot to specific
Telegram user IDs; everyone else is dropped before any handler runs, with no
reply at all (an error reply would confirm to a scanner that the token is live).
Leave it empty and the bot is open to everyone — the startup banner says which
mode is active.

To find your own ID, start the bot with the allowlist set to any value and
message it; the denial is logged as `access.denied telegramId=<yours>`.

The gate is middleware registered above every handler (`src/bot/bot.ts`), so
handlers are unreachable rather than individually permission-checked.
`ctx.from.id` is stamped by Telegram's servers, not the sender's client, so it
cannot be forged by a caller. It is authorization, not concealment: strangers can
still message the bot, they just get no response. It does not mitigate a leaked
token — anyone holding the token can redirect updates, so rotate via BotFather
`/revoke` if it is ever exposed.

## Deployment

The bot long-polls, so it needs **outbound network only** — no public URL, no
inbound ports, no TLS certificate. A `Dockerfile` is included and runs on any
container host.

Three things that will cause data loss or silent breakage if missed:

- **Mount a persistent volume at `/data`.** It holds users' encrypted key
  material. On an ephemeral filesystem (the default on several PaaS providers)
  every redeploy destroys every wallet — and because there is deliberately no
  plaintext export path, those funds are unrecoverable.
- **Reuse the same `MASTER_ENCRYPTION_KEY`.** Regenerating it makes an existing
  keystore permanently undecryptable.
- **Run exactly one instance.** Two processes polling the same token compete for
  updates and both misbehave. Do not autoscale; pin replicas to 1.

Avoid free tiers that idle-stop the process — a stopped poller is an unresponsive
bot. Note that deploying with `MEZO_NETWORK=mainnet` and an empty allowlist means
an unattended agent custodying strangers' real BTC on the Tier-3 stopgap
described under "Trust model"; prefer testnet, or an allowlist, until the custody
tier is upgraded and independently audited.

## Verifying it works

All checks below run with **no Telegram token and no network dependency on
Telegram** — `scripts/_testenv.ts` stubs the environment and must be the first
import in any check (ESM evaluates every `import` before the module body, so
assigning `process.env` inside a script's own body runs too late).

| command | covers |
| --- | --- |
| `npm run smoke` | custody round-trip, wallet creation, live testnet balance read, intent parsing |
| `npm run smoke2` | seed-phrase import, per-tx spend caps, watch-only mode |
| `npm run policycheck` | signer policy: allowlist, caps, watch-only, reserve/release ledger |
| `npm run phasecheck` | Phase 2–5 logic: borrow, lock, DCA keeper, optimal voting, fee cap |
| `npm run accesscheck` | access gate: unlisted user reaches no handler and gets no reply |
| `cd contracts && forge test` | `SessionKeyDelegate` (25 tests, incl. 14 audit regressions) |

`npm run smoke` specifically checks:

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
  (`npm run contracts:test`, **25 tests**, 14 of them audit regressions). It went
  through **two rounds** of adversarial audit (Pashov `solidity-auditor`: 12 agents
  on the original, 6 on the hardened rewrite). **Every finding from both rounds is
  fixed and regression-tested** — self-call escalation, stale allowlist, ERC-20
  calldata caps, trailing-24h window, `transferFrom` source validation, and a
  revocation-DoS. See **[AUDIT.md](AUDIT.md)**. Deploy it with
  `contracts/script/Deploy.s.sol` and set `DELEGATE7702_ADDRESS` to enable
  `/upgrade`. It remains unaudited by a third party pending the security review.
