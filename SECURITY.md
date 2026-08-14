# Security posture

The current, authoritative statement of where this system stands. It supersedes
`AUDIT.md` and `AUDIT2.md`, which are kept only as history and carry banners
saying so.

The rule this file exists to enforce: **a stale audit document is worse than no
audit document**, because it is what the next reviewer reads to decide what they
do *not* need to look at. Everything below is either true today or marked as
open.

---

## What the system is

A Telegram agent that operates Mezo's Bitcoin-DeFi stack in natural language.
Users get a **contained-custodial** account: the bot holds an encrypted key and
signs on their behalf, inside per-transaction and rolling-24h spending caps, with
an explicit confirmation card before every fund-moving action.

An EIP-7702 non-custodial path exists in the repository and is **switched off**.
See "The delegate" below — that is a deliberate position, not an oversight.

---

## What a third-party review found, and what changed

An independent correctness and security review read the agent against the `musd`
protocol source and against live on-chain state on both networks. It confirmed
that much of the earlier hardening was real, and it found three structural
problems that the earlier rounds had never looked at. All three are closed.

### 1. The agent's model of the protocol had drifted from the protocol

Every `musd` parameter was a compile-time constant, and several were wrong:

| Parameter | Was | Live (verified on-chain) |
|---|---|---|
| Borrowing rate | `1%` hardcoded | **0.1%**, and governance-mutable |
| Gas compensation | **omitted entirely** | **200 MUSD**, added to every Trove's debt |
| Recovery Mode / CCR | unmodeled | opens gate on **150%**, fee waived |
| `maxBorrowingCapacity` | never read | a sticky cap stamped at open time |

The two arithmetic errors partially cancelled at about 22,222 MUSD of debt.
**Below** that — most retail borrowers — the agent understated the debt, so it
displayed "110% ✅" for a Trove really sitting at 99% that `openTrove` would
reject, and the liquidation warning was up to 10% optimistic in the direction
that gets people liquidated.

That constrained the fix: correcting the fee alone would have removed the
accidental protection large Troves were getting from the inflated fee, so the fee
and the gas compensation had to be corrected together.

**Now:** `src/core/musdParams.ts` reads gas compensation, borrowing rate, minimum
net debt, MCR, CCR, Recovery Mode and the per-Trove borrowing cap from the chain,
and every surface shares one debt model. Three separate hand-rolled copies of the
old arithmetic — in the borrow builder, the menu tip card, and the
collateral-sizing helper — are gone. Reads **fail closed**: if the parameters or
the price cannot be read, the bot refuses to build a plan rather than guess.

`npm run conformance` asserts the agreement against the live contracts and
reproduces the review's worked example.

### 2. The plan a user approved was not necessarily the plan that got signed

There was one pending slot per user, overwritten unconditionally, and the confirm
buttons were constant strings carrying no plan identity. So a user could see
card A, have plan B silently replace it, tap Confirm on A, and sign B.

**Now:** every card carries a single-use random id in its callback data;
`takePending` matches that id and deletes the plan in the same synchronous step
before any `await` (which also closes the double-tap race); superseded cards are
disarmed; and a plan built for one account will not sign under another.

### 3. Unattended automation was unbounded

`"dca 50 MUSD into BTC every 0 hours"` created a schedule that fired every 60
seconds forever — roughly 1,440 unattended swaps a day from one typed message —
because the deterministic parser returned before Zod validation ran. The keeper
had no in-flight guard and advanced `nextRunAt` only *after* the swap resolved,
so a run slower than one tick executed two or three times. And there was no
rolling-24h cap on ERC-20s at all, only a per-transaction one, so an hourly DCA
was twenty-four separately-legal transactions that no layer could see the total
of.

**Now:** intervals are validated at creation *and* the deterministic parser's
output goes through the schema; overlapping ticks are refused; the slot is
claimed before the executor runs; and there is a rolling-24h aggregate cap per
token.

### Also closed

- **The signer's target allowlist was tautological** — it read `allowedTargets`
  out of the plan, so it asked the plan whether the plan was allowed. It now
  independently requires every target to be registry-known, the configured fee
  recipient, or an address a builder verified on-chain this session
  (`src/custody/attest.ts`).
- **veNFT transfers were uncapped** — the asset is named by a token id in the ABI
  arguments, so `msg.value` was 0 and no ERC-20 descriptor existed; caps and the
  step-up confirmation were skipped entirely. Transfers are now priced by the
  locked amount, and the destination is checked.
- **Slippage was settable up to 50%** — the highest-leverage prompt-injection
  target in the app, since `minOut` is the only value protection on the swap
  path. Capped at 5%.
- **The atomic swap reported success on submission** — it never set
  `waitForReceipt`, so "Swap complete" rendered for transactions that could still
  revert. The legacy path always set it; the path that actually runs did not.
- **Guardrails failed open on a stale price.** `PriceFeed.fetchPrice` reverts
  once the oracle is over 60s old, and the borrow surface caught that and
  *skipped* the collateral-ratio check. It now blocks — the protocol would reject
  the transaction for the same reason anyway.
- **`PriceFeed.lastGoodPrice` was a phantom selector**, and it was the only probe
  `verifyaddrs` used for that contract, so PriceFeed silently failed verification
  while the registry claimed every address "answers its own interface". Removed;
  the probe uses `fetchPrice`.
- **The vote optimizer was blind to most of the voting universe** — it iterated 3
  compiled-in pools while mainnet's Voter holds 26 gauges carrying ~80% of total
  weight, and still called its answer "optimal". It now measures its own coverage
  against `Voter.length()`, states it on the card, and only uses the word
  "optimal" when coverage is near-complete.
- **`increaseUnlockTime` was passed a delta** where the contract expects a
  duration measured from now, so "extend by 7 days" reverted for anyone with more
  than 7 days left — the users with the most at stake.
- **The secret guard covered one update type.** `bot.on("message:text")` does not
  match `edited_message`, so typing anything and editing it into a private key
  hit no handler. It is middleware now, over every text-bearing update including
  captions.
- **`/export` was armed forever on every card that had ever shown it**, with no
  TTL and no second factor, and its copy promised an "auto-delete" that an
  in-process timer cannot guarantee. It now needs a fresh single-use token, and
  the copy says best-effort because that is what it is.
- **A torn datastore write could destroy every custodial wallet.** Persistence
  was a bare `writeFileSync` of the whole file from ~18 call sites, and the load
  path ran `JSON.parse` at module scope from `export const store = new Store()` —
  so a file truncated by a crash mid-write threw at *import* time, before any
  handler existed, and with no plaintext export path every sealed key in it was
  unrecoverable. Writes are now atomic (temp + fsync + rename) with a backup and
  a guarded, quarantining load. `npm run storecheck` proves it survives a
  simulated crash.
- **Error text reached logs and chat unredacted.** Exception strings from
  viem/grammY routinely quote the RPC URL they called. `redact()` now strips
  key-, token- and credential-shaped substrings at both sinks.
- **`revokeSession` had no caller.** The delegate has always exposed it and
  nothing in the bot reached it, so a leaked session key stayed valid for its
  full 30-day TTL with nothing the user could do. `/revoke` is that caller; it
  clears the session locally even when the on-chain call has to be retried, so
  the bot stops signing through it immediately.
- **The zap ignored the user's slippage setting**, hardcoding 0.5% while
  `ZapIntent` accepted a value — so widening tolerance to get a thin-pool zap
  through changed nothing and it reverted again with no explanation.
- **The bot's own profile called itself "non-custodial"** while the EIP-7702 path
  that would make that true is deliberately disabled. It now describes what it
  actually is.
- **FeeRouter:** the per-call override ceiling was the bare `MAX_OVERRIDE_BPS`
  constant rather than the configured rate, so lowering `feeBps` to 50 still let
  a caller charge 200 — four times what the owner set, making `MAX_FEE_BPS`
  governance cosmetic. The referral share could be set to exactly 100%, zeroing
  operator revenue through config that reads as valid. Ownership transfer was one
  step, so a mistyped successor permanently forfeited `rescue` and the fee
  configuration. Fee-on-transfer inputs were sized from the amount *requested*
  rather than the amount *received* — invisible to the whole suite, because the
  mock router moved exactly what it was asked for. All fixed, with tests that can
  actually see each class.

---

## Second review round (12 adversarial agents, both contracts)

A second multi-agent pass over `FeeRouter.sol` and `SessionKeyDelegate.sol`
after the fixes above. It found one **live production** defect, two regressions
introduced by those very fixes, and two contract defects; all are closed.

- **The fee-token allowlist had never been armed, and could not be.** The gate
  that binds which token the fee is *denominated* in is fail-open until an
  operator arms it — and the only script that arms it built its list from each
  token's `.address`, which for native BTC is the zero sentinel. `setFeeTokens`
  reverts the whole batch on a zero entry, so the transaction could never
  succeed. Worse, the script passed an explicit `gas`, which makes viem skip
  `estimateGas`, and it discarded the receipt's `status` — so it printed a tx
  hash and then "✅ synced" while the gate stayed off. With the gate off, the
  fee is charged on `routes[0].from`, which is caller-chosen: an attacker mints
  a worthless token, makes it hop 0, settles the real trade on hop 1, and the
  operator is paid in dust. Fixed by allowlisting **routing** addresses (BTC's
  precompile, which is what `routes[0].from` actually carries — allowlisting
  `.address` would have latched the gate on and reverted every BTC swap) and by
  asserting `receipt.status` on every write.
- **My own `_ceilingBps` fix broke the legacy zap path.** Scaling the override
  ceiling by *this call's* leg multiplier collapsed `swapWithFee`'s band to the
  single point `[feeBps, feeBps]`. When the deployed router lacks
  `zapLegWithFee`, the zap surface legitimately sends a doubled override through
  `swapWithFee` — which then reverted `FeeTooHigh` *after* both approvals had
  been mined, stranding live allowances. The ceiling is now 2x the **configured**
  rate regardless of entrypoint: governance over `feeBps` stays meaningful (it
  was the bare constant before, so lowering the rate to 50 still permitted 200),
  and every honest leg is representable. Regression test added.
- **My own `/revoke` fix could orphan a session key permanently.** It deleted
  the local record even when the on-chain revocation failed — and the delegate
  can only revoke a key *by name*, with no enumeration and no revoke-all. The
  address was the only handle that could ever revoke it, so the key stayed live
  for the rest of its 30-day TTL, unreachable. The comment even talked about
  retrying. Orphans are now recorded and retried, `/revoke` says plainly that
  the key is still live on-chain, and `enableSmartAccount` refuses to mint a
  replacement while an un-revoked predecessor exists (registering a new key does
  **not** invalidate the old one).
- **A cached probe failure created phantom referral liabilities.** `feeRouterCaps`
  memoised its result including failures, and reported "capability absent" for
  both "the router lacks it" and "I could not read the bytecode". One RPC blip
  at startup therefore made the bot skip the on-chain referral binding check for
  the rest of the process: it quoted the referred discount the contract would not
  give (the trader silently overpaid, absorbed by slippage) and credited
  referrers commissions the contract never paid. Failures are no longer cached,
  the two states are distinguished, and the referral path fails **closed** on an
  unknown capability.
- **A zero referral share was a pure giveaway.** `_referralActive`'s own comment
  claimed three conditions — attested, not self, *and a share actually paid* —
  but implemented two. With `maxReferralShareBps == 0` (a config the setters
  accept) every bound trader received the discount while the referrer was paid
  nothing. The predicate now matches its comment.

Also corrected: two NatSpec claims the agents showed to be false (the override
band, and the fee-token gate being "populated immediately by the deploy script"
— nothing populates it), and two previously-undisclosed delegate defects added
to its open-defect header, including that the **call-target allowlist is reused
as the payee allowlist**, so a stolen session key can transfer tokens into
another allowlisted token contract and burn them permanently.

## Known limitations — stated, not hidden

- **Mezo Market is partially implemented.** Browsing is a preview; purchases
  route as swaps. The README says so on the surface itself.
- **The vote optimizer's coverage is partial** on mainnet. The card now says how
  partial, every time, rather than presenting a 3-of-26-gauge answer as optimal.
- **`refinance` is not implemented**, which is the only mechanism that re-stamps
  a Trove's borrowing cap. When a mint is blocked by the cap, the bot says
  exactly that instead of advising "add more BTC", which does not raise it.
- **Hints are passed as zero** on Trove operations. That is a valid Liquity
  fallback and cheap at current Trove counts; `getApproxHint` is not called. The
  code used to claim otherwise and no longer does.
- **The zap's doubled fee is not enforceable on-chain.** `zapLegWithFee` charges
  2x because the caller chose that entrypoint, and the selector is calldata like
  any other — a caller composing their own zap can use `swapWithFee` and pay 1x.
  The contract's claim that "the leg kind is no longer calldata the caller
  chooses" was false and has been corrected. This is bounded: the same caller can
  bypass the FeeRouter entirely and pay zero, so fee capture is a routing
  convenience, not an on-chain constraint. Making it real means executing both
  zap legs inside the contract, which is a redesign, not a patch.
- **This has not had a third-party smart-contract audit.** The FeeRouter and the
  delegate have been through adversarial multi-agent review and the findings are
  fixed, but that is not the same thing and should not be presented as if it
  were.

## Before real money at scale

In order: a **fork test** exercising `openTrove`/`adjustTrove`/`closeTrove`
against forked state, which converts the conformance arithmetic here into
observed behaviour; then a **third-party audit** of the borrow conformance layer
and the confirm/signing boundary; then a **capped pilot** with low per-user
limits and automation off by default.

---

## The delegate

`contracts/src/SessionKeyDelegate.sol` is built, adversarially audited, and
**deliberately switched off**. Its own header lists five open bypasses proven
with executable PoCs — including one where tightening a policy under attack
refills the attacker's budget, and another where native BTC and its ERC-20
precompile are metered in two independent rings, doubling the daily budget.

That header is the authoritative list. The quarantine is verified:
`UPGRADE_7702_ENABLED` defaults off with a strict comparison and
`enableSmartAccount` has exactly one caller behind it.

Shipping caps that *look* binding and are not is worse than shipping the
contained-custodial path, whose caps genuinely hold in the signer. Two things
must be true before it reopens: the prescribed balance-delta accounting rewrite,
plus a fresh audit.

The **session→root signing downgrade is already gone**. The signer used to
re-sign with the root key any operation the delegate refused, which made the
delegate's on-chain caps advisory — anything outside them was not blocked, only
routed around — so the guarantee the smart-account path advertises would have
been void the moment it shipped. It refuses now, and points the user at
`/revoke` if they genuinely want to sign directly again. It was unreachable
today only because `/upgrade` is off, and "unreachable for now" is not a
property to leave a rewrite standing on.

---

## Reporting a vulnerability

Email **partnerships@integralayer.com** with "SECURITY" in the subject. Please
report privately first and allow time to fix before disclosing. See
`MAINTENANCE.md` for response targets.

## Verifying any of this

```
npm run conformance   # the agent agrees with the deployed protocol
npm run storecheck    # a torn write cannot destroy custody
npm run policycheck   # spending caps bind, including BTC via the precompile
npm run exportcheck   # /export needs a fresh single-use token
npm run parsecheck    # 77 natural-language commands parse deterministically
npm run routercompat  # the calldata the bot emits exists on the deployed router
npm run productcopy   # no user-facing string assumes testnet
cd contracts && forge test
```
