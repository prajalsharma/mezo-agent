# Security Audit — SessionKeyDelegate.sol

On-chain component: `contracts/src/SessionKeyDelegate.sol` (the EIP-7702 delegate
that enforces session-key scope for the non-custodial custody path).

**Method:** parallelized 12-agent adversarial audit (Pashov Audit Group
`solidity-auditor` skill) — twelve specialty lenses (access-control,
economic-security, execution-trace, invariant, math-precision, boundary,
periphery, first-principles, asymmetry, numerical-gap, trust-gap, flow-gap) run
independently, then deduplicated and gate-verified. Plus a manual review of the
TypeScript custody path (keystore, signer, delegation, store).

Findings below are ranked by verified severity with the number of independent
agents that converged on each.

---

## F1 — CRITICAL · Self-call confused-deputy privilege escalation · FIXED

**Agents:** 10/12 · **`execute`**

The session path did not reject `to == address(this)`. A session key whose
allowlist included the account's own address could call
`execute(address(this), 0, <registerSession/execute calldata>)`; the delegate's
own `_call` then performed `address(this).call(data)`, and the **nested frame's
`msg.sender` is `address(this)`** — satisfying `onlySelf` / the uncapped root
branch. A capped, revocable session key could thus re-register itself with
unlimited caps or drain the entire native balance in one transaction, defeating
the whole custody model.

**Fix (`SessionKeyDelegate.sol`):**
- `execute` session branch reverts `SelfTargetForbidden` when `to == address(this)`, before any allowlist/cap check.
- `registerSession` and `setTarget` reject `address(this)` as a target (defense in depth — the precondition can never be created).

**Tests:** `test_cannotRegisterSelfAsTarget`, `test_sessionCannotCallDelegateItself`, `test_setTargetRejectsSelfAndRequiresSession`.

---

## F2 — HIGH · Stale allowlist: scope narrow/revoke silently fails · FIXED

**Agents:** 9/12 · **`registerSession` / `revokeSession`**

`registerSession` only ever set `_allowed[key][t] = true` (additive union), and
`revokeSession` deleted the `Session` struct but never touched `_allowed`. So
re-registering a key with a narrower target list, or revoking then reusing a key
address, left previously-granted targets silently live — the enforced scope
diverged from the scope the root (and the emitted event) declared.

**Fix:** the contract now tracks each key's target list (`_keyTargets`) and
**clears the previous allowlist** (`_clearTargets`) before applying a new one in
`registerSession`, and on `revokeSession`. Scope is now replaced, not unioned.
`setTarget` also now requires the session to exist.

**Tests:** `test_reRegisterReplacesTargets`, `test_revokeClearsAllowlistAcrossReuse`.

---

## F3 — HIGH · Value-only caps don't bound ERC-20/calldata · ACKNOWLEDGED + SCOPED

**Agents:** 5/12 · **`execute`**

The per-tx / daily caps bound `msg.value` (native BTC) only. An allowlisted
target that moves assets via a `value == 0` call (ERC-20 `transfer`/`approve`, a
vault `redeem`) is **not** bounded by the caps. This is inherent to native-value
caps and was over-claimed by the original NatSpec.

**Resolution:**
- The contract NatSpec now states the guarantee **accurately**: caps bound native
  value only; do **not** allowlist a target holding large standing
  balances/approvals for a session key.
- The off-chain signer registers only the specific targets a session needs and
  uses **minimal per-action approvals** (the swap builder approves exactly
  `amountIn` to the router, so standing approvals are ~0).
- The worst escalation that F3 enabled (self-call → root) is closed by F1.
- **Next phase (documented, not hidden):** amount-aware ERC-20 caps via a
  per-target selector allowlist + balance-delta policy. Implementing this
  correctly (constraining the `approve` spender argument, not just the selector)
  is a deliberate follow-up rather than a rushed partial fix.

---

## F4 — MEDIUM · Fixed-window 2× daily-cap burst · ACKNOWLEDGED + DISCLOSED

**Agents:** 5/12 · **`execute`**

The daily window is a fixed window anchored at `dayStart`, not a true sliding
window: a key can spend `dailyCap` just before a boundary and again just after,
moving ~2× cap in seconds. (Note: the commonly-suggested "advance `dayStart` by
whole days" does **not** fix this — only a trailing-24h spend log does.)

**Resolution:**
- NatSpec corrected: it is a **fixed 24h window**, not "rolling"; ~2× cap across a
  boundary is the accepted on-chain bound.
- The **off-chain signer enforces a true rolling-24h cap** (`store.spentLast24hWei`
  is a real trailing window) for app-mediated sessions — defense in depth.
- A full on-chain sliding window (timestamped spend log) is a documented option;
  it trades gas for eliminating the boundary burst.

---

## TypeScript custody review (manual) — no vulnerabilities found

- **No secret exposure:** keys are AES-256-GCM sealed; the keystore has no
  plaintext-export path; decryption happens only inside a scoped `use()` closure
  with buffer scrubbing; import errors are sanitized so a raw key/seed never
  reaches an error string, log, or the LLM. (`npm run smoke`.)
- **Signer defense-in-depth:** independent policy re-check (watch-only, allowlist,
  native caps, opt-in per-token cap); daily-cap **reserve-before-submit** closes a
  TOCTOU window; releases on failure. (`npm run policycheck`.)
- **Session path:** the outer 7702 tx targets the account; the ultimate target is
  double-enforced (off-chain allowlist + on-chain delegate). Address-match checks
  guard against a sealed key not matching its account.

---

## Verification

```
cd contracts && forge test      # 16 tests (5 are audit regressions) — all pass
npm run smoke / policycheck / phasecheck / swapcheck   # green
```

The delegate remains **unaudited by a third party**; this is an AI-assisted
adversarial pass. A professional review is required before mainnet, per the
bounty's security-review gate.
