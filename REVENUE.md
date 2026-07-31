# Revenue Model

The bounty encourages a sustainable business model and suggests three specific
mechanisms:

> "a small fee on swaps/zaps executed through the agent, a subscription for
> automation features (DCA, auto-convert), or a performance component on
> automated strategies. Builders retain full ownership of their fee structure;
> it must be transparently disclosed to users in-bot."

This agent implements all three, each **transparently disclosed in-bot** (every
fee appears on the confirmation card and under `/fees`), and each **off by
default** so an operator opts in explicitly.

## 1. Transaction fee (the bounty's "small fee on swaps/zaps")

A basis-point fee taken from the **input token** of a trade, shown on every
confirmation before the user approves — never silent, and **hard-capped at 100
bps (1%) in code** so a misconfiguration can't overcharge.

| Action | Recommended | Config |
| --- | --- | --- |
| Swap **and zap** | **50 bps (0.5%)** — half the 100 bps that Trojan/Maestro charge | `AGENT_FEE_BPS=50` |
| Borrow / vault-deposit / lock | **10 bps (0.1%)** — Mezo-approved; taken in the action's token | `AGENT_TXN_FEE_BPS=10` |

Enable:
```
AGENT_FEE_BPS=50
AGENT_FEE_RECIPIENT=0x<operator address>
```

At 0.5% on $1M daily swap volume ≈ **$5,000/day** gross. The fee applies to
swaps and zaps, plus a small 10 bps fee on borrow/vault-deposit/lock (approved
by the Mezo team). Claims and votes are never charged (collecting your own
rewards). Each fee is taken in the action's own token and charged only after the
action confirms.

### Referral share (growth, funded from the fee)

A percentage of the transaction fee is **split at source, on-chain, in the same
transaction** to whoever referred the trader (deep-link `t.me/<bot>?start=<id>`).
No accrual, no claim, no operator-held payout key — the referred user's own trade
settles it instantly and trustlessly. Disclosed under `/referral` and `/fees`.

```
AGENT_REFERRAL_SHARE_PCT=30    # 30% of the fee → referrer; industry range 10–35% L1
AGENT_REFERRED_FEE_BPS=45      # optional; default = 90% of AGENT_FEE_BPS
```

**Both sides of the referral get value** (the universal pattern across Trojan /
GMGN / BullX, which all charge referred users 0.9% vs a 1% headline):

| Party | What they get | When |
| --- | --- | --- |
| Referred trader | Reduced swap fee **for life** (`AGENT_REFERRED_FEE_BPS`, default 90% of headline — e.g. 45 bps vs 50 bps) | Every swap |
| Referrer | `AGENT_REFERRAL_SHARE_PCT` (30%) of the agent fee on **every** swap their referral ever makes | Instantly, on-chain, inside the referral's own swap transaction |
| Operator | The remaining 70% of the fee | Same transaction |

Worked example at the approved rates: a referred user swaps 1,000 MUSD → fee
4.50 MUSD (0.45%) → referrer receives **1.35 MUSD instantly**, operator receives
3.15 MUSD, and 995.50 MUSD is swapped. Settlement is verifiable on-chain per
trade — no other bot in the researched market (Trojan, Maestro, BONKbot, Banana
Gun, GMGN, Photon) settles referrals at source; they batch daily or require
claiming above a minimum.

## Collection architecture (why fees can't be lost)

- **Swaps & zaps — atomic (`contracts/src/FeeRouter.sol`):** the trade routes
  through the operator-deployed FeeRouter, which pulls the input, splits the fee
  (referrer share + operator share), swaps the remainder, and delivers output
  directly to the user — all in ONE transaction. A failed swap charges nothing;
  a successful swap has already collected the fee. Escrowless; fee rate
  hard-capped on-chain at 100 bps (1%). Zaps collect their whole fee in the swap
  leg via a per-call rate override (2× bps on half the input = bps on gross;
  override ceiling 200 bps exists solely for this accounting).
- **Borrow / vault / lock — post-action with retry + ledger:** the 10 bps fee is
  charged only AFTER the action confirms (a failed action never pays), retried
  up to 3× on transient RPC failures, and — if it still fails — recorded in a
  persistent **owed-fee ledger** so uncollected revenue is logged and auditable,
  never silently lost. (These cannot be made atomic by a wrapper: Liquity troves
  are one-per-address and veNFTs mint to the caller, so a fee contract would own
  the user's position.)

## 2. Automation subscription (the bounty's "subscription for DCA / auto-convert")

DCA and epoch auto-compound are premium automation. The subscription price is
disclosed via `/fees`:

```
AGENT_AUTOMATION_NOTE="DCA & auto-compound: 5 MUSD / month"
```

The keeper already gates scheduled execution behind a global kill-switch and
per-user pause; a subscription check is the natural gate on schedule creation
(a small addition when an operator wants to charge — the disclosure hook is
already live).

## 3. Performance component (the bounty's "performance component on strategies")

For automated strategies (auto-compound), a performance fee on realized gains is
the third lever. Not enabled by default; the same input-token fee mechanism
applies at claim/convert time when configured. Documented as a roadmap lever so
the operator "retains full ownership of their fee structure."

## Transparency guarantees (bounty requirement)

- Every fee is shown on the **pre-confirmation card** with the exact amount, in
  the token it's taken from, before the user approves.
- `/fees` lists the swap fee %, the referral share %, and any automation note.
- `/referral` shows the user's link, referral count, and earnings per token.
- Nothing is charged unless the operator sets `AGENT_FEE_BPS > 0` **and** a valid
  `AGENT_FEE_RECIPIENT` — the default deployment charges zero.

## Recommended launch configuration (Mezo-approved rates)

```
AGENT_FEE_BPS=50                # 0.5% swaps & zaps (approved)
AGENT_TXN_FEE_BPS=10            # 0.1% borrow / vault-deposit / lock (approved)
AGENT_REFERRED_FEE_BPS=45       # referred traders pay 0.45% for life (optional; default 90% of headline)
AGENT_REFERRAL_SHARE_PCT=30     # 30% of the fee → referrer, instant on-chain
AGENT_FEE_RECIPIENT=0x<operator revenue wallet>
FEE_ROUTER_ADDRESS=0x<deployed FeeRouter>   # npm run deployfeerouter -- --deploy
AGENT_AUTOMATION_NOTE="DCA & auto-compound: 5 MUSD / month"
```

### Complete rate table (as disclosed in-bot via /fees)

| Action | Rate | Collection |
| --- | --- | --- |
| Swap | 50 bps (0.5%) of input | Atomic, in the swap tx (FeeRouter) |
| Swap — referred user | 45 bps (0.45%), lifetime | Atomic |
| Zap | 50 bps (0.5%) of gross input | Atomic, in the swap leg |
| Borrow | 10 bps (0.1%) of minted MUSD | After trove opens; retry + ledger |
| Vault deposit | 10 bps (0.1%) of deposit | After deposit; retry + ledger |
| Lock (veBTC/veMEZO) | 10 bps (0.1%) of locked amount | After lock; retry + ledger |
| Claim rewards / vote / deposit / portfolio / DCA setup | **0** | — |
| Referrer's cut | 30% of the fee on referred swaps | Instant, same tx, on-chain |

Market context (researched July 2026 vs. DefiLlama/Dune-verified data): every
surviving competitor charges **1% gross** (Axiom $714M lifetime fees, GMGN
$236M, Trojan $225M, Maestro $140M — all at 1%). The approved 50/10 bps sits at
half the market rate; raising the headline later is a one-variable change.
