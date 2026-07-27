# Security Audit — SessionKeyDelegate.sol

On-chain component: `contracts/src/SessionKeyDelegate.sol` (the EIP-7702 delegate
that enforces session-key scope for the non-custodial custody path).

**Method:** parallelized adversarial audit using the Pashov Audit Group
`solidity-auditor` skill — independent specialty lenses (access-control,
economic-security, execution-trace, invariant, math-precision, boundary,
periphery, first-principles, asymmetry, numerical-gap, trust-gap, flow-gap), then
deduplicated and gate-verified. **Two rounds:** round 1 on the original contract
(12 agents), round 2 on the hardened rewrite (6 agents targeting the new
mechanisms). Plus a manual review of the TypeScript custody path.

**Status: every finding from both rounds is FIXED and regression-tested.**
`forge test` — 25 tests, all passing.

---

## Round 1

### F1 — CRITICAL · Self-call confused-deputy privilege escalation · FIXED
**10/12 agents · `execute`**

The session path did not reject `to == address(this)`. A session key allowlisted
for the account's own address could call `execute(address(this), 0, <mgmt calldata>)`;
`_call` then performed `address(this).call(data)`, and the **nested frame's
`msg.sender` is `address(this)`** — satisfying `onlySelf` / the uncapped root
branch. A capped key could re-register itself with unlimited caps or drain the
balance in one transaction.

**Fix:** `execute` reverts `SelfTargetForbidden` when `to == address(this)` before
any other check; `registerSession`/`setTargetPolicy` reject `address(this)` as a
target (so the precondition can never be created).
**Tests:** `test_cannotRegisterSelfAsTarget`, `test_sessionCannotCallDelegateItself`.

### F2 — HIGH · Stale allowlist: narrowing/revoking scope silently failed · FIXED
**9/12 agents · `registerSession` / `revokeSession`**

`registerSession` only ever added to `_allowed` (union, not replace) and
`revokeSession` never cleared it, so re-registering with a narrower target list —
or revoking then reusing a key — left old targets live.

**Fix:** the contract tracks each key's targets and selectors and **clears them**
before applying a new scope, and on revoke. Scope is replaced, not unioned.
**Tests:** `test_reRegisterReplacesScope`, `test_revokeClearsScopeAcrossReuse`.

### F3 — HIGH · Value-only caps didn't bound ERC-20 movement · FIXED
**5/12 agents · `execute`**

Caps bounded `msg.value` only. An allowlisted target that moves assets via a
`value == 0` call (ERC-20 `transfer`/`approve`) was completely uncapped.

**Fix (real, not documentation):**
- **Per-(key, target) selector allowlist** — calldata is no longer a blank cheque;
  an unlisted selector reverts.
- **Decoded amount caps** — `transfer`/`approve`/`transferFrom` amounts are decoded
  from calldata and capped per-tx *and* per trailing 24h, exactly like native value.
- **Counterparty rule** — the recipient/spender must be an allowlisted target and
  may not be the token itself, so a key cannot approve an attacker.
- **No uncapped selectors on token targets** — a target carrying token caps may
  only be granted the three decoded selectors, closing the misconfiguration trap.

**Tests:** `test_unlistedSelectorRejected`, `test_erc20TransferCappedByDecodedAmount`,
`test_erc20DailyTokenCap`, `test_cannotApproveArbitrarySpender`,
`test_cannotSendTokensToTokenItself`, `test_tokenTargetRejectsUncappedSelector`.

### F4 — MEDIUM · Fixed-window 2× daily-cap burst · FIXED (see R1 below)
**5/12 agents · `execute`**

The daily window was a resettable fixed bucket: spend the cap before a boundary,
spend it again after. First replaced with a weighted sliding window — which round
2 proved was **still** exploitable (see R1).

---

## Round 2 — audit of the hardened rewrite

### R1 — HIGH · Sliding window still allowed 2× per true trailing 24h · FIXED
**4/6 agents (economic, math-precision, invariant, + verified independently)**

The weighted two-bucket counter decayed the previous window's usage *linearly with
elapsed time*, assuming spend was smeared uniformly across it. Concentrating spends
at bucket edges defeats that. Verified trace (`dailyCap = 1000`):

| t | amount | weightedPrev | used | result |
|---|---|---|---|---|
| 86 399 | 1000 | 0 | 1000 | PASS |
| 129 600 | 500 | 500 | 1000 | PASS |
| 172 799 | 500 | 0 | 1000 | PASS |

True trailing 24h `[86399, 172799]` contains **2000 = 2× cap**.

**Fix:** replaced with a **bucketed ring** — 13 buckets × 2h, summing the most
recent 13. Because `(13-1) × 2h = 24h`, every spend is counted for **at least 24
hours** before it can age out, so the cap cannot be exceeded in any true trailing
24h. O(13) reads, packed one slot per bucket.
**Tests:** `test_noDoubleSpendWithinTrueTrailing24h`, `test_slidingWindowBlocksBoundaryDoubleSpend`,
`test_slidingWindowFreesUpAfterFullPeriod`.

### R2 — HIGH · `transferFrom` source unvalidated · FIXED
**4/6 agents · `_enforceTokenPolicy`**

`(, counterparty, amount) = abi.decode(...)` discarded `from`. A session key could
call `transferFrom(victim, allowlistedRecipient, amount)` and drain **any third
party's** allowance granted to this account — extending blast radius far beyond the
account's own balance.

**Fix:** decode `from` and require `from == address(this)`, reverting
`ForeignSourceForbidden` otherwise.
**Test:** `test_transferFromForeignSourceRejected`.

### R3 — HIGH · Unbounded `_keyTargets` growth → revocation DoS · FIXED
**3/6 agents · `_clearTarget`**

`_clearTarget` cleared the per-target mappings but never removed the target from
the `_keyTargets` array, while `_applyPolicy` re-pushed it. Ordinary, documented
policy churn (`setTargetPolicy`, or `removeTarget` + re-add) grew the array without
bound, so `_clearScope` — used by **`revokeSession`** — could eventually exceed the
block gas limit. That breaks the contract's central promise: revocability, exactly
when it's needed most.

**Fix:** a 1-based `_targetIndex` makes membership explicit; `_clearTarget` removes
the entry via swap-and-pop, so the array holds each target at most once.
**Test:** `test_targetArrayDoesNotGrowOnPolicyChurn` (10 churn cycles → count stays 1).

### R4 — LOW · Zero token cap didn't actually deny · FIXED
`tokenPerTxCap == 0` is documented as "decoded transfers denied", but `0 > 0` is
false so zero-amount calls passed. Now `perTx == 0` reverts outright.

---

## Accepted residual risk (documented, bounded)

**Revocation cannot retroactively zero an ERC-20 allowance** a session key already
granted via `approve`. This is inherent — an allowance lives on the token contract.
It is **bounded**: an approval may only name an **allowlisted** spender and may not
exceed `tokenPerTxCap`. The root can always sweep it with
`execute(token, 0, approve(spender, 0))`. Operators should allowlist only trusted
spenders (e.g. the canonical DEX router). Stated in the contract NatSpec.

---

## TypeScript custody review (manual) — no vulnerabilities found

- **No secret exposure:** AES-256-GCM sealed keys; no plaintext-export path;
  decryption only inside a scoped `use()` closure with buffer scrubbing; import
  errors sanitized so a raw key/seed never reaches a log, error string, or the LLM.
- **Signer defense-in-depth:** independent policy re-check (watch-only, allowlist,
  native caps, per-token cap); daily-cap **reserve-before-submit** closes a TOCTOU
  window and releases on failure.
- **Automation:** kill-switch re-checked on **every** keeper tick (not just at
  startup), plus per-user `/pause` — a stray direct call cannot bypass it.

---

## Verification

```bash
cd contracts && forge test      # 25 tests — all pass
npm run smoke / policycheck / phasecheck / swapcheck   # all green
```

The delegate remains **unaudited by a third party**; this is an AI-assisted
adversarial pass across two rounds. A professional review is required before
mainnet, per the bounty's security-review gate.
