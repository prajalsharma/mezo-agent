# Contracts — SessionKeyDelegate (EIP-7702)

The on-chain half of the mainnet custody model ("Option A": semi-custodial). An
account's root EOA installs `SessionKeyDelegate` as its EIP-7702 delegation
designator (`0xef0100 || SessionKeyDelegate`) and registers a scoped **session
key**. Routine ops are then signed by the session key and enforced on-chain:
allowlisted targets, per-tx cap, rolling-24h cap, and expiry. Session management
is root-only (`msg.sender == address(this)` under 7702 self-execution).

## Layout

```
src/SessionKeyDelegate.sol      the delegate
test/SessionKeyDelegate.t.sol   unit tests (limits, allowlist, expiry, revoke)
script/Deploy.s.sol             one-shot deploy (one per network)
```

## Build & test

```bash
forge install foundry-rs/forge-std   # first time only
forge test -vv
```

## Deploy (testnet first)

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.test.mezo.org \
  --private-key $DEPLOYER_KEY --broadcast
```

Then wire the address into the app:

1. Put the deployed address under the `Delegate7702` key for the matching
   network in `../src/registry/addresses.ts`.
2. Once verified on the explorer, remove `Delegate7702` from that network's
   `needsConfirmation` list.
3. Restart the bot and run `/diag` — the `eip7702` check should report
   `delegate=<address>`. Accounts can then `/upgrade`.

## Mezo-specific notes

- `evm_version = cancun` — the contract uses no Prague/Osaka-only opcodes, and
  Mezo diverges on PREVRANDAO / block-hash history (neither is used here).
- The delegate must NOT be deployed in Mezo's precompile range (`0x7b7c…`):
  EIP-7702 rejects authorizations whose target is a precompile.
- Caps bound **native BTC** value only, matching the off-chain Phase-1 policy.
  Per-token (ERC-20) USD caps arrive with the price feed.

## Before mainnet

This is unaudited Phase-1 code. Get a security review before mainnet, and
consider hardening items intentionally left minimal here (e.g. per-session
target lists sized for gas, batch execute, and a signature-based session path
if you later want a relayer to sponsor gas instead of the session EOA).
