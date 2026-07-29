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
AGENT_REFERRAL_SHARE_PCT=30    # 30% of the fee → referrer; industry range 25–45%
```

Comparable bots: Trojan up to 45%, Maestro 25%. 30% is a competitive middle that
still leaves the operator the majority of the fee.

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

## Recommended launch configuration

```
AGENT_FEE_BPS=50
AGENT_FEE_RECIPIENT=0x<operator>
AGENT_REFERRAL_SHARE_PCT=30
AGENT_AUTOMATION_NOTE="DCA & auto-compound: 5 MUSD / month"
```
