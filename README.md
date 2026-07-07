# Mezo Conversational Agent — Architecture Design

A Telegram-delivered natural-language agent that operates the full Mezo Bitcoin-DeFi stack (Borrow, Swap, Earn/zap, Claims, veBTC/veMEZO locking + voting, Matchbox pairing, Mezo Market), with every fund-moving action gated behind a simulated, human-readable confirmation.

This document is the architecture deliverable: the trust model, component layout, intent→transaction pipeline, per-surface integration notes, the "optimal" voting/pairing design, the automation/keeper design, and how each choice maps to the bounty's weighted evaluation criteria.

---

## 1. Design principles

The whole system is organized around one non-negotiable invariant, which is also the most heavily weighted scoring criterion:

> **The LLM proposes; deterministic code disposes.** The language model is a parser that emits a _structured intent_. It never holds keys, never produces raw calldata, never invents addresses or amounts, and never has final authority to move funds. Everything that can move value is built, validated, simulated, and executed by deterministic code, and gated by an explicit user confirmation and on-chain policy.

Everything below follows from four rules:

1. **Secrets never cross the reasoning boundary.** No key, seed, or session secret is ever sent to an LLM provider, written to a log, or stored in plaintext. This is an automatic blocker in the security review, so it is enforced architecturally (separate signer process, separate secret store), not by convention.
2. **Defense in depth, not a single gate.** Confirmation happens at three layers: app-level (the user taps confirm), scope-level (the signer will only sign within policy), and chain-level (the smart-account validator rejects anything outside its allowlist/caps). A compromise of any single layer should not drain an account.
3. **Simulate before sign.** Every state-changing transaction is dry-run and decoded into plain language before the user sees a confirmation.
4. **Addresses come from a registry, never from the model.** All contract addresses are read from the canonical Mezo contracts reference and cached, never hardcoded and never emitted by the LLM.

---

## 2. What Mezo actually is (and why it shapes the design)

Grounding the design in Mezo's real mechanics, because several of them have direct architectural consequences:

- **Chain.** Mezo is EVM-compatible (Cosmos SDK + CometBFT), and **BTC is the native gas asset.** Consequence: gas accounting, "do you have enough to cover gas," and funding flows are all denominated in BTC, not ETH. Testnet ("Matsnet") is chain id `31611`, RPC `https://rpc.test.mezo.org`; build and exercise everything there first.
- **Borrow / MUSD is a Liquity-style CDP system.** Core contracts: `BorrowerOperations`, `TroveManager`, `SortedTroves`, `ActivePool`, `DefaultPool`, `StabilityPool`, `CollSurplusPool`, `PCV`, `PriceFeed`. Positions are "Troves." Consequences for the tx builder:
  - `openTrove` / `adjustTrove` require **`upperHint`/`lowerHint`** for insertion into the sorted list. Hints go **stale** if someone else's trove changes ordering, so they must be fetched (via `HintHelpers` / `SortedTroves.findInsertPosition`) _immediately_ before the transaction, not cached.
  - Risk surfaces to model and warn on: **ICR** (individual collateral ratio), **TCR**, **MCR = 110%**, **Recovery Mode** (system-wide TCR threshold that changes behavior), minimum net debt (**1,800 MUSD**), borrowing rate (from 1%), redemption fee (0.75%), and accruing interest.
  - All Mezo contracts are **proxies** — resolve implementation ABIs but call the proxy address.
- **Earn is a Velodrome-style ve(3,3).** `VotingEscrow` (veNFTs), gauges, a voter contract, splitters (Chain Splitter / Ecosystem Splitter), weekly MEZO emissions, and rebases. **Epochs are weekly and flip Thursday 00:00 UTC** — this is the single most important scheduling constant in the system.
  - **veBTC**: lock BTC (short locks, ~1–28/30 days, linear decay) → base voting power + a claim on protocol fees, paid largely **in BTC**.
  - **veMEZO**: lock MEZO (up to 4 years) → boosts a paired veBTC position's weight/earnings **up to 5×**; has no standalone voting power but is independently productive via the matching market.
  - Fees/bribes are paid in a **mix of tokens** (BTC for chain/interest/bridging fees; arbitrary ERC-20 for DEX fees and bribes), which the claim-all and auto-convert flows must handle generically.


---

## 3. Component architecture

The system is a set of services separated along the trust boundary shown in the diagram. They are deliberately decoupled so that the security-critical path (validator → signer → on-chain) does not depend on any single agent framework (e.g. ElizaOS), which the bounty itself flags as fast-moving.

**Gateway — Telegram bot.** Webhook handler, conversation/session state, rate limiting, idempotency on inbound updates. Renders pre-confirmation summaries and inline Confirm/Cancel buttons. Untrusted with funds.

**Reasoning — LLM adapter (provider-agnostic).** A thin adapter exposing one interface (`parseIntent`, `disambiguate`) over multiple vendors (Anthropic / OpenAI / local), so the agent isn't locked to one model. Uses tool/function-calling with a fixed schema. Receives only non-sensitive context (balances, available pools, the user's message). Output is always a typed `Intent`, never calldata.

**Deterministic core.** The trusted heart of the system:

- _Intent validator / policy engine_ — validates the `Intent` against a strict schema (Zod or equivalent), enforces app-level policy (per-action caps, allowlists, watch-only mode), and triggers disambiguation when fields are missing/ambiguous. Never guesses amounts or addresses.
- _Contract registry_ — fetches and caches canonical Mezo addresses + ABIs; versioned; surfaces ABI/address changes (a maintenance requirement). Single source of truth for addresses.
- _Transaction builder_ — per-surface builders (Borrow, DEX, Earn, VotingEscrow, Matchbox, Market) that turn an `Intent` into one or a _plan_ of calls (e.g. a zap = swap + swap + addLiquidity + stake). Handles hints, slippage min-outs, deadlines, approvals.
- _Simulator_ — `eth_call` with state overrides (or a simulation provider) to dry-run each step; decodes the result into human-readable effects (new ICR, expected LP out, min received, resulting lock end, expected fees).
- _Confirmation formatter_ — renders the decoded effect into the Telegram summary.

**Optimizer service.** Computes the "optimal" voting allocation and veBTC/veMEZO pairing recommendation (§7). Read-only and fully auditable — it produces a _recommendation_ that still flows through the normal intent→confirm→sign pipeline.

**Signer / custody service.** An isolated process whose only job is "sign this operation if it is within policy." It holds the session key in a KMS / enclave / MPC backend and exposes no key material to the rest of the system. Independently re-checks policy before signing. (§4)

**Keeper / scheduler.** Cloud cron + worker for DCA and epoch auto-convert. Triggers pre-authorized, scoped, idempotent actions; has a global kill-switch and per-user pause. (§8)

**Indexer / portfolio (read path).** Separate from the write path. Reads balances, Trove health, LP positions, veNFTs, and claimable rewards from RPC / Mezo Explorer / a subgraph for the live portfolio view.

**Datastore.** Postgres for users, _public_ addresses, encrypted references to session-key policies, schedules, and transaction history; Redis for conversation state and registry cache. Secrets live only in the KMS/enclave, never in Postgres in plaintext.

**Observability.** Structured action logs, per-user transaction history, and an error decoder that translates reverts into plain language (insufficient collateral ratio, expired lock, zero voting weight, slippage exceeded, stale hint).

---

## 4. Custody model — the part the bounty is really testing

This is the highest-weighted criterion and the one most submissions will get wrong by holding raw keys. The design target is **non-custodial, scoped, revocable delegation**: the agent holds only a narrowly-scoped, time-bound, revocable permission; the user retains custody and can revoke at any time.

**Important caveat to resolve in week one:** the bounty cites ERC-4337 session keys and EIP-7702 as the preferred model, but neither is guaranteed to be live on Mezo's Cosmos-SDK EVM. EIP-7702 needs Prague-style type-4 transaction support; ERC-4337 needs a deployed `EntryPoint` plus a bundler. The reference Mezo apps observed in the wild use plain EOA wallets. **So the first architecture task is a capability probe**: does Mezo have a canonical `EntryPoint` + public bundler? Does it accept 7702 authorizations? The custody design therefore is a _tiered strategy that degrades gracefully_ rather than a bet on one primitive:

**Tier 1 — Smart account + on-chain session-key module (preferred, bundler-optional).**
Deploy the user a smart account via an audited factory (Safe / Kernel / equivalent) whose owner is the user's key. Register a _session-key validator module_ (ERC-7579 / 7715-style) that enforces, **on-chain**: allowed target contracts (the Mezo registry), allowed function selectors, per-token spend caps, and an expiry. The agent's signer holds only the session key.

- Crucial insight: you do **not** strictly need a 4337 bundler. If the smart account exposes a permissioned `execute` path guarded by the module, the agent's relayer can call it directly and the **module still enforces scope on-chain**. This avoids depending on Mezo bundler infrastructure that may not exist, while keeping the non-custodial property. If a bundler _is_ available, use the standard UserOperation path and optionally a BTC paymaster.
- Blast radius of a fully-compromised bot host: bounded by the on-chain policy (specific contracts, capped spend, expiring key). That is the story security reviewers want.

**Tier 2 — EIP-7702 delegation (if Mezo supports it).**
The user signs a 7702 authorization delegating their existing EOA to a session-key delegation contract; same scoping, but the user keeps their original address (good for users who already hold BTC at an address). Revocation = re-delegate to the zero address.

**Tier 3 — contained custodial fallback (only if no AA path is viable).**
If neither AA primitive is available on Mezo at build time, generate the key in-bot but contain the risk so it is _not_ a plaintext-key liability:

- Key material lives only in KMS/HSM or an MPC signer — never plaintext, never logged, never sent to an LLM.
- Wrap the account in an on-chain spend-guard contract that enforces spend limits and allowlists, so even the operator cannot exceed policy.
- Per-action confirmation remains mandatory; scheduled actions remain separately pre-authorized.
- Document the trust model explicitly: what the operator can and cannot do, where keys live, and what happens if the host is compromised.

**Raw seed / private-key import** is offered only as an explicit opt-in, behind a clear risk warning, encrypted at rest, never logged, never sent to an LLM, ideally enclave/MPC-backed. It is never the default path.

**Spending limits & thresholds** apply across all tiers: per-action allowances, daily caps, and a confirmation threshold above which extra verification is required — so a compromised _session_ cannot drain an account.

---

## 5. Intent → transaction pipeline

The end-to-end path for any fund-moving message:

1. **Parse.** LLM adapter turns the message into a typed `Intent`, e.g.
   `{ action: "borrow", collateralBTC: 0.1, mintMUSD: 5000 }` or
   `{ action: "zap", inputToken: "BTC", inputUSD: 800, targetPool: "MUSD/mUSDC" }`.
   The schema enumerates allowed actions and field types; anything off-schema is rejected.
2. **Validate & disambiguate.** Deterministic checks: required fields present, amounts in range, token symbols resolvable via the registry. If ambiguous ("enter the pool with some BTC") → ask the user; never guess. The LLM cannot smuggle in an address — addresses are looked up, not parsed from text.
3. **Build.** The per-surface builder maps the `Intent` to a concrete call plan, resolving addresses from the registry, computing hints (Borrow), slippage min-outs and deadlines (Swap/zap), and any required token approvals. Multi-step flows (zap, claim-all) are explicit ordered plans with rollback/abort semantics.
4. **Simulate.** Each step is dry-run; results are decoded into human-readable effects.
5. **Confirm.** The user sees a summary — action, amounts in/out, fees, slippage, and resulting position health (e.g. "new collateral ratio: 184%") — with Confirm/Cancel. Scheduled actions are instead pre-authorized once with explicit, revocable parameters.
6. **Sign & submit.** On confirm, the signer signs _within policy_; the tx is submitted (private/MEV-aware path for swaps where available), monitored, and the result surfaced. Reverts are decoded and explained.

---

## 6. Per-surface integration notes

**Borrow (MUSD / Troves).** `openTrove`, `adjustTrove` (add/withdraw collateral, repay/borrow in one call), `closeTrove`, `claimCollateral`. Always fetch fresh hints immediately pre-tx. Always compute and display pre/post ICR and warn near MCR (110%) and on Recovery Mode. Enforce the 1,800 MUSD minimum net debt. Surface the borrowing fee and accrued interest.

**Swap (DEX).** Quote via the router, enforce a configurable slippage tolerance as an on-chain min-out, set a deadline, and route through an MEV-resistant path where the chain supports it. Never execute a swap from a single ambiguous message.

**Earn / zap.** Vault deposits (e.g. MUSD Savings Vault → sMUSD) and LP entry. Zap-to-enter takes a single asset + a target pool, computes the correct split, performs the swaps, adds liquidity, and (if opted in) stakes the LP into the gauge — all as one confirmed plan. Handle partial-fill / failed-leg recovery explicitly (a documented edge case).

**Claims.** A single "claim everything" plan aggregating rebases, gauge/pool earnings, and voting/bribe earnings across surfaces. Because rewards arrive in mixed tokens (BTC + arbitrary ERC-20), the claim flow enumerates claimable positions from the indexer rather than assuming a fixed token set.

**Locking & veNFTs.** Create veBTC (short locks) and veMEZO (up to 4y) via `VotingEscrow`; extend locks; transfer/merge veNFTs; and pair veBTC with veMEZO (or use Matchbox cross-pairing). Warn on expired locks and zero-weight positions.

**Voting.** Vote veBTC across pool gauges via the voter contract, with a manual mode and an "optimal" mode (§7). Note votes persist across epochs unless changed.

**Mezo Market.** Browse and purchase items. Same confirm-before-spend rules.


---

## 7. Automation & the keeper

DCA ("buy $50 of BTC every Monday") and epoch auto-convert ("at each epoch end, claim everything and swap into token X") run on a cloud cron + worker. Requirements baked into the design:

- **Pre-authorization, not standing blanket approval.** Each schedule is a separately scoped, time-bound session-key grant with its own caps, created via an explicit one-time confirmation and revocable at any time.
- **Idempotency.** Jobs carry idempotency keys and DB-backed state so a retried or duplicated trigger never double-executes.
- **Epoch awareness.** Auto-convert is anchored to the Thursday 00:00 UTC epoch flip, with **missed-epoch recovery** (if a run is missed, the next run reconciles rather than skipping silently).
- **Kill-switch & pause.** A global emergency stop and per-user pause for all scheduled automation, with proper access control on these admin/keeper functions.

---

## 8. Observability & error handling

- Structured, queryable action logs and per-user transaction history.
- A revert decoder that turns failures into plain language: insufficient collateral ratio, expired lock, zero voting weight, slippage exceeded, stale hint, below-minimum-debt, recovery-mode restriction.
- Documented edge-case handling (the bounty asks for this explicitly): expired locks, zero voting weight, near-liquidation Troves, failed/partial zaps, slippage failures, scheduled-action retries, and recovery after a missed epoch.

---

## 9. Data model (sketch)

- `users` — telegram id, account address(es), mode (active / watch-only), preferences.
- `accounts` — public address, account type (smart account / 7702-delegated / contained-custodial), encrypted _reference_ to the session-key policy (not the key).
- `session_policies` — allowed targets, selectors, per-token caps, expiry, revocation status.
- `schedules` — DCA / auto-convert definitions, scope grant, next-run, idempotency cursor, paused flag.
- `tx_history` — intent, plan, simulation result, status, decoded effect, hashes.
- `registry_cache` — contract addresses + ABIs, version, fetched-at.
- Secrets (session keys) — **only** in KMS/enclave/MPC, addressed by reference.

---

## 10. Threat model → mapped to the security rubric

| Review focus                 | How the architecture addresses it                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Custody & key handling       | Tiered non-custodial design; keys only in KMS/enclave/MPC; never plaintext, never logged, never to an LLM; raw import opt-in only    |
| Authorization & confirmation | App + scope + on-chain confirmation; scheduled actions separately pre-authorized, scoped, revocable; kill-switch                     |
| Transaction correctness      | Simulate-before-sign; registry-sourced addresses; fresh hints; slippage/MEV min-outs; per-surface builders matched to real contracts |
| Access controls              | Permissioned keeper/admin functions; emergency pause; watch-only mode; per-action caps                                               |

---

## 11. Tech stack recommendation

- **Language:** TypeScript end-to-end. Zod schemas double as the LLM tool schema _and_ the deterministic validator — one definition, two enforcement points.
- **Chain libs:** `viem` (+ a 4337/session-key SDK such as permissionless.js / ZeroDev / Kernel if AA is available on Mezo). Mezo Passport (`@mezo-org/passport`, built on OrangeKit/RainbowKit) for BTC wallet flows (Unisat / OKX / Xverse) as a bonus.
- **Bot:** grammY or Telegraf (webhook mode).
- **Simulation:** `eth_call` with state overrides; optionally a hosted simulation provider.
- **Keeper:** cloud cron + worker with DB-backed idempotent jobs.
- **Secrets:** cloud KMS / HSM or an MPC signer. No app-level-only encryption for keys.
- **Stores:** Postgres + Redis.
- **Agent framework:** treat ElizaOS/Olas as _optional_ glue, not load-bearing. Keep the validator, signer, and tx engine framework-independent so a framework change can't weaken the security path.

---

## 12. Open questions to resolve before building (week-one probe)

1. Does Mezo have a deployed ERC-4337 `EntryPoint` + public bundler? Does it accept EIP-7702 authorizations? (Determines which custody tier is primary.)
2. Exact canonical addresses/ABIs for the voter, gauges, `VotingEscrow` (veBTC and veMEZO), and Market contracts — from the contracts reference, on both Testnet and Mainnet.
3. Whether a subgraph/indexer exists for portfolio + claimable-rewards reads, or whether the indexer must be built.
4. BTC-as-gas handling in the chosen AA SDK (paymaster in BTC, gas estimation).

---

## 13. How this maps to the evaluation criteria

- **Security & Custody** → §4 tiered non-custodial model + §11 threat map.
- **Functionality** → §5 pipeline + §6 per-surface builders covering all required flows.
- **Intent Accuracy** → §1 + §5: schema-validated intents, disambiguation, no invented addresses/amounts.
- **UX** → §3 gateway + §5 step 5 pre-confirmation summaries with position health.
- **Optimization Quality** → §7: water-filling vote allocation + self-vs-cross pairing, transparent and labeled as estimates.
- **Code Quality / Documentation** → framework-independent core, single-source schemas, documented trust model.
- **Long-term Viability** → registry-driven addresses + ABI-change surfacing (eases the 6-month maintenance commitment); monetization can sit as a transparent fee in the tx builder's plan step.
