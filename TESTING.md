# Testing Checklist — every bounty task, verified

How to use: run the **In-Telegram** checks against the live bot (testnet), tick
each box. `Expected` is the pass criterion — anything else is a bug. Items
marked 🔒 are executable-blocked on unpublished contract addresses (see README
"Address provenance"); their check verifies the *correct gated behaviour*, which
is what a reviewer can exercise today.

Automated evidence (run locally, no Telegram needed):

| Command | Proves |
| --- | --- |
| `npm run phaseaudit` | Which surfaces can sign vs. preview, live against the registry |
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

## 3 · Swaps — ✅ quote + slippage; 🔒 execution (Router unpublished)

- [ ] (mainnet) `swap 100 MUSD to mUSDC` → live pool quote (~99 mUSDC), slippage tolerance shown, fee line if configured
- [ ] (testnet) same message → "I don't know mUSDC on testnet. Known tokens: BTC, MUSD." — **names the unknown token, never guesses**
- [ ] Quote screen shows minimum-received at the configured slippage
- [ ] Execution attempt → clear "Router address not confirmed" gate, not a silent failure
- [ ] `swap 2 XYZ to BTC` → refuses unknown token (never invents an address)

## 4 · Earn: vaults, zap, LP stake — 🔒 (vaults/Voter/Router unpublished)

- [ ] `zap 0.01 BTC into MUSD/mUSDC` → split + expected LP preview, staking opt-in question, gated at execution with the reason named
- [ ] `stake LP MUSD/mUSDC` / `unstake LP MUSD/mUSDC` → correct preview + gate reason (Voter)
- [ ] `deposit 100 MUSD into vault` → preview + gate reason (vault addresses unpublished)

## 5 · Claims — 🔒 (Voter / RewardsDistributor unpublished)

- [ ] `claim all` → aggregated claim-everything plan (rebases + bribes + gauge), gated with reason
- [ ] `claim rebases` / `claim bribes` → scope parsed correctly into the plan

## 6 · Locking & veNFTs — 🔒 (VotingEscrow unpublished)

- [ ] `lock 0.2 BTC for 28 days` → veBTC preview; `for 40 days` → **refused** (1–28d bound)
- [ ] `lock 1000 MEZO for 2 years` → veMEZO preview (≤4y bound enforced)
- [ ] `extend lock 1 by 30 days` · `transfer veNFT 1 to 0x…` · `merge veNFT 1 into 2` → correct previews
- [ ] `pair my veBTC` (Matchbox) → gated with reason

## 7 · Voting — ✅ optimizer math live; 🔒 on-chain submit

- [ ] `vote optimally` → water-filling allocation with **per-gauge explanation**
      (transparency required by "Optimization Quality" criterion); submit gated on Voter
- [ ] Optimizer unit-proof: `npm run phasecheck` (allocation sums to 100.00% bps, no negative weights)

## 8 · Mezo Market — 🔒 (address unpublished)

- [ ] `browse market` / `buy listing 42` → parsed, previewed, gated with reason

## 9 · Bonus features — ✅ all live (DCA trades land once Router exists)

- [ ] `dca 50 MUSD to BTC every 24h` → schedule card: amount, pair, interval, revocable — requires explicit confirm
- [ ] Keeper tick appears in Railway logs; run reports "swap execution gated" (correct until Router)
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
| Slippage exceeded | Min-received encoded in swap plan; tx reverts rather than fills badly (execution pending Router) |
| Expired lock / zero voting weight | Gated surfaces; decoded-error paths implemented, exercisable once VotingEscrow/Voter exist |
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
| Full execution of swap/earn/lock/vote/market | ⏳ blocked on unpublished addresses — ask #developers in Mezo Discord |
