# Testing Checklist — every bounty task, verified

How to use: run the **In-Telegram** checks against the live bot (testnet), tick
each box. `Expected` is the pass criterion — anything else is a bug. Items
marked 🔒 are executable-blocked on unpublished contract addresses (see README
"Address provenance"); their check verifies the *correct gated behaviour*, which
is what a reviewer can exercise today.

Automated evidence (run locally, no Telegram needed):

| Command | Proves |
| --- | --- |
| `npm run phaseaudit` | Which surfaces can sign vs. preview, live against the registry (10 executable + 3 live-checks on testnet) |
| `npm run verifyve` | Router + ve(3,3) addresses: on-chain cross-reference proof |
| `npm run simcheck` | Borrow calldata simulates against the real chain (openTrove succeeds) |
| `npm run verifyaddrs` | Wired addresses have code + 5/5 cross-references on-chain |
| `npm run smoke` / `smoke2` | Custody round-trip, no plaintext at rest, import + caps |
| `npm run policycheck` | Signer blocks: over-cap, unknown target, watch-only, TOCTOU ledger |
| `npm run phasecheck` | DCA keeper lifecycle, optimal-voting math, fee cap |
| `npm run accesscheck` | Unlisted Telegram user reaches no handler, gets no reply |
| `npm run contracts:test` | SessionKeyDelegate: 25 tests incl. 14 audit regressions |

---

## 1 · Onboarding & funding — ✅ fully testable

- [ ] `/start` → welcome + Create / Import buttons; testnet/mainnet indicator shown
- [ ] Tap **Create a new wallet** → address shown; **no seed phrase or key ever displayed**
- [ ] `/deposit` → QR code renders + plain-text address (scan it with a phone)
- [ ] Fund via https://faucet.test.mezo.org/ → `/portfolio` shows the BTC within ~1 min
- [ ] **Import path is opt-in + warned**: `/start` → Import → risk warning appears BEFORE any key is accepted
- [ ] Import a throwaway key → message containing the key is handled, wallet address matches
- [ ] `/portfolio` → BTC + MUSD balances, Trove section, readable at a glance

## 2 · Borrow (MUSD / Troves) — ✅ executable, simulated on both networks

- [ ] `borrow 2000 MUSD against 0.1 BTC` → confirmation card shows: collateral,
      mint amount, ~1% borrowing fee, resulting debt, **110% MCR liquidation warning**
- [ ] Confirm → tx hash → verify on https://explorer.test.mezo.org → `/portfolio` shows Trove
- [ ] `borrow 100 MUSD against 0.1 BTC` → **refused**: below 1,800 MUSD minimum net debt (guardrail, not error)
- [ ] `repay 500 MUSD` → approve step + repay step described → confirm → debt drops
- [ ] `add 0.05 BTC collateral` (adjust) → ratio-improving step ordering → executes
- [ ] `close trove` → warns full debt must be covered → executes (or decoded shortfall)
- [ ] Simulation-before-sign: attempt any borrow action with insufficient funds →
      decoded human reason (e.g. "Trove does not exist or is closed"), **no tx submitted**

## 3 · Swaps — ✅ EXECUTABLE both networks (incl. native BTC via precompile)

- [ ] `swap 100 MUSD to mUSDC` → live pool quote, min-received at slippage, fee line if configured → Confirm → tx hash
- [ ] `swap 0.01 BTC to MUSD` → native swap routes through the BTC ERC-20 precompile (approve + swap; no wrapping step shown)
- [ ] `swap 2 XYZ to BTC` → refuses unknown token (never invents an address)
- [ ] Testnet token set now includes mUSDC/mUSDT (published pools verified on-chain)

## 4 · Earn: vaults, zap, LP stake — ✅ zap/stake EXECUTABLE (testnet); 🔒 vaults

- [ ] `zap 0.01 BTC into BTC/MUSD` → live split quote → approve/swap/approve/addLiquidity steps → Confirm → LP lands
- [ ] `zap 0.01 BTC into MUSD/mUSDC` → multi-hop named refusal (input not a pool token) — asks you to swap first
- [ ] `stake LP BTC/MUSD` → gauge resolved live from Voter; with no LP → "You hold no BTC/MUSD LP to stake" (live balance read)
- [ ] `unstake LP BTC/MUSD` → same live checks against the gauge
- [ ] Mainnet: Voter has 26 live gauges (incl. all three registry pools) — stake/claim fully live there too
- [ ] `deposit 100 MUSD into vault` → preview + gate reason (ERC-4626 wiring pending)

## 5 · Claims — ✅ gauge claims EXECUTABLE; 🔒 rebase/bribe (needs veNFT enumeration)

- [ ] `claim all` → enumerates every pool's gauge from the Voter, claims where earned > 0; with nothing earned → live "Nothing to claim from gauges right now"
- [ ] `claim rebases` / `claim bribes` → scope parsed; gated with the veNFT-enumeration reason

## 6 · Locking & veNFTs — ✅ veBTC EXECUTABLE; 🔒 veMEZO/Matchbox

- [ ] `lock 0.2 BTC for 28 days` → approve-precompile + createLock steps → Confirm → veNFT minted; `for 40 days` → **refused** (1–28d bound)
- [ ] `lock 1000 MEZO for 2 years` → veMEZO preview (escrow unpublished; ≤4y bound enforced)
- [ ] `extend lock 1 by 30 days` → increaseUnlockTime executes · `transfer veNFT 1 to 0x…` · `merge veNFT 1 into 2` → execute (must own the veNFT)
- [ ] `pair my veBTC` (Matchbox) → gated with reason (community project)

## 7 · Voting — ✅ manual EXECUTABLE; optimal = optimizer live, submit needs indexer

- [ ] `vote with veNFT 3: 60% MUSD/mUSDC, 40% BTC/MUSD` → Voter.vote calldata, executes (must own the veNFT)
- [ ] `vote manually` without a veNFT id → asks for the id (never guesses)
- [ ] `vote optimally` → water-filling allocation with **per-gauge explanation**; submission gated on the incentives indexer (we never fabricate incentive numbers)
- [ ] Optimizer unit-proof: `npm run phasecheck` (allocation sums to 100.00% bps, no negative weights)

## 8 · Mezo Market — 🔒 (address unpublished)

- [ ] `browse market` / `buy listing 42` → parsed, previewed, gated with reason

## 9 · Bonus features — ✅ all live (DCA trades execute via the wired Router)

- [ ] `dca 50 MUSD to BTC every 24h` → schedule card: amount, pair, interval, revocable — requires explicit confirm
- [ ] Keeper tick appears in Railway logs; due runs now EXECUTE the swap through the Router (within the signer caps)
- [ ] `/dca` → lists schedules; `cancel dca <id>` revokes
- [ ] `auto-compound on` → preference stored; `off` clears
- [ ] `/pause` → keeper skips this user (check log line) → `/resume` restores — **emergency kill-switch**
- [ ] `/limits` → view + set per-tx cap → over-cap action **blocked by the signer**, with the cap named
- [ ] `/watch` → watch-only mode: any signing attempt refused
- [ ] `new account` → second address; `switch to account 1` → `/portfolio` follows; funds isolated
- [ ] `/fees` → fee disclosure (bps + recipient, or "no fees configured")

## 10 · Security behaviours (review will probe these)

- [ ] Stranger (non-allowlisted Telegram ID) messages the bot → **total silence**, `access.denied` in logs
- [ ] Ambiguous message ("swap some tokens") → bot asks, never guesses amount/token
- [ ] No secret in logs: grep Railway logs for key material → nothing (keys AES-256-GCM at rest)
- [ ] LLM path receives intent text only — no key, no seed, ever (`src/llm/adapter.ts`)
- [ ] Double-confirm: single message never moves funds; every plan needs the explicit button
- [ ] `KEEPER_ENABLED=false` redeploy → all schedules halt (global kill-switch)

## 11 · Edge cases (bounty "Testing" section) — documented status

| Edge case | Behaviour today |
| --- | --- |
| Below min-debt borrow | Refused pre-simulation with the 1,800 MUSD floor named |
| Near-liquidation Trove | MCR warning on every card; live ratio computed pre-sign |
| Insufficient balance/allowance | Simulation surfaces decoded revert; nothing submitted |
| Unknown token / pool | Named refusal; never invents an address |
| Slippage exceeded | Min-received encoded on-chain in every swap/zap leg; tx reverts rather than fills badly |
| Expired lock / zero voting weight | Live surfaces; protocol reverts decode to human text (custom-error cases explained generically) |
| Scheduled-action retry | Keeper marks run, reports reason, retries next tick; occurrence limit enforced |
| Missed epoch | Auto-compound fires on next tick after due; idempotent (no double-run) |
| Failed/partial zap | Plan is atomic per step with receipt waits; failure halts the chain and reports the step |

## 12 · Deliverables tracker

| Deliverable | Status |
| --- | --- |
| GitHub repo | ✅ code complete (currently private — must be public/mirrored at submission) |
| README + trust model | ✅ |
| Live **Testnet** deployment | ✅ Railway, always-on, volume-backed |
| Maintenance plan | ✅ in SUBMISSION.md |
| Video demo | ❌ **to record** — script: onboarding → borrow → zap preview → claim-all preview → lock+vote preview → market preview → DCA live |
| Live Mainnet deployment | ⏳ after security review (bounty's own ordering) |
| Full execution of swap/zap/stake/claim/lock/vote | ✅ wired + on-chain verified, live gauges on BOTH networks |
