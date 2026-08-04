# Maintenance Plan

The bounty requires "a written commitment to maintain, bug-fix, and improve the
agent for a minimum of 6 months following mainnet deployment, including keeping
pace with Mezo contract/ABI changes and epoch-timing updates."

## Commitment period

Six months from the date of mainnet deployment, with the intent to continue
beyond that if the agent sees real usage.

## What is covered

**Contract and ABI drift.** Mezo addresses are read from a canonical registry
(`src/registry/`), never hardcoded at call sites, so an address change is a
registry edit rather than a code change. See "Address provenance and
verification" in the README. Verification: `npm run verifyaddrs` re-resolves every
address against the live chain and fails loudly on a mismatch.

**Epoch timing.** ve(3,3) epochs flip weekly at Thursday 00:00 UTC. The epoch
maths lives in one place (`src/keeper/alerts.ts`, `epochStartMs`/`msToEpochFlip`)
so a schedule change is a single edit with direct test coverage.

**Security fixes.** Critical and high-severity issues take priority over feature
work. The repo carries a reproducible audit harness (12 parallel adversarial
agents over the Solidity surface) plus deterministic check scripts, all runnable
before any deploy:

```
npm run parsecheck      # 53 natural-language parse cases
npm run referralcheck   # referral split and ledger
npm run feeverify       # fee rates on every surface
npm run phasecheck      # Phase 2-5 behaviour incl. keeper
npm run deadendcheck    # every advertised capability is reachable
cd contracts && forge test
```

**Known open items** are listed in the README's "Known limitations" section and
in the `NOT PRODUCTION-READY` banner at the top of
`contracts/src/SessionKeyDelegate.sol`. That banner is deliberately blunt about
what is not yet safe; it must be kept accurate as items are closed.

## Response targets

| Severity | Example | Target |
| --- | --- | --- |
| Critical | funds at risk, key exposure | acknowledge within 24h, mitigate or disable the affected surface immediately |
| High | a core flow is broken for all users | acknowledge within 48h, fix within 7 days |
| Medium | a surface is broken for some users | fix in the next release |
| Low | copy, UX, non-blocking | best effort |

The fastest mitigation is always available and does not require a code change:
every gated surface has an env kill-switch (README, "Enabling gated surfaces"),
and `KEEPER_ENABLED=false` halts all scheduled execution immediately.

## Support channels

- **GitHub issues** on this repo - primary channel for bugs and feature
  requests, and the one with a public record.
- **Mezo Discord `#developers`** - ecosystem coordination and contract/ABI
  change notices.
- **In-bot `/help`** - user-facing questions, with `/portfolio` and the
  transaction history covering most "did my trade land?" cases without a
  support round-trip.
- **Email: partnerships@integralayer.com** - for anything security-sensitive.
  Please do not open a public issue for a vulnerability; mail this address and
  allow a reasonable window to ship a fix before disclosure.

## Release process

1. Changes land on a branch, never straight to the deployed branch.
2. The full check suite above must pass with no manual environment setup.
3. Contract changes get a fresh adversarial audit pass before deploy.
4. Testnet first, then mainnet.

## What this plan does NOT promise

Being explicit so the commitment is credible:

- No uptime SLA. The bot runs on a single host; a host outage means downtime.
- No custody guarantee beyond the documented trust model (README, "Trust
  model"). Users retain the ability to export and revoke.
- No support for Mezo surfaces that do not exist yet; new surfaces are feature
  work, prioritised on their merits.
