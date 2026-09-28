# Wrapped USDC mint

Issue [#47](https://github.com/Dnreikronos/cadence/issues/47). Creates and
inspects the mint Cadence pays in: devnet USDC wrapped into Token-2022 through
our own token-wrap deployment ([ops/token-wrap](../token-wrap/README.md)).

## Running it

```bash
cd ops/mint && cargo test
```

```bash
cd ops/mint && cargo run -- inspect
```

```bash
cd ops/mint && OPS_KEYPAIR=<payer> cargo run -- create
```

```bash
cd ops/mint && OPS_KEYPAIR=<payer> cargo run -- wrap 10000000
```

`inspect` is read-only and needs no key. It derives every address from devnet
USDC and the wrap program ID, reads the mint, and fails unless it is exactly
what stock token-wrap produces. `create` is idempotent. `wrap` takes base units
(six decimals, so the line above is 10 USDC) and afterwards checks that the
escrow holds exactly the wrapped supply.

| Variable | Default | |
|---|---|---|
| `OPS_RPC_URL` | `https://api.devnet.solana.com` | |
| `OPS_KEYPAIR` | none | payer for `create` and `wrap`, never generated |

`wrap` needs devnet USDC in the payer's associated account. Circle's faucet at
<https://faucet.circle.com> sends 20 every two hours; pick Solana Devnet.

The token-wrap instructions are written out by hand, because the program crate
is on the 2.x Solana crates. `the_seeds_match_upstream` checks the derivation
against upstream's own CLI output, so the addresses cannot quietly drift.

## Devnet

| | |
|---|---|
| Wrapped USDC | [`CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb`](https://explorer.solana.com/address/CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb?cluster=devnet) |
| Wraps | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, Circle's devnet USDC |
| Wrap program | `8vc29A8ztm3pE5qJ43paHTMGtBTnf5jXvyqcPQcTjJZc` |
| Mint authority | `AwkUx7CcemjKiERJ2ycDBSQierNkfRXEyjzVa2SYBLei`, the wrap program's PDA |
| Escrow | `3FGZS8R5hZcn11okupbXbR8dzztpC1GcjApLeCDSdKen`, holds the USDC behind every wrapped token |
| Backpointer | `2P8or4tpmH2tVvviR4k4bNz22tipGc4TjtegtksyWbWQ` |
| Freeze authority | `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`, copied from devnet USDC, so Circle's |
| Created | 2026-09-28, [`221BoxFM…mCq61a`](https://explorer.solana.com/tx/221BoxFMRzNGf2MPJtRxwNQZ3Cuiu3acNJWry6eAffeedd2e4pbJDBdKaCNdn3vEhkiFVuVeQDLJk7ezmjmCq61a?cluster=devnet) |

Nothing here is secret, and nothing has to be kept in sync by hand: all of it
follows from the two addresses at the top, and `inspect` derives it again.

## What the mint turned out to be

```text
extensions       [ConfidentialTransferMint, MetadataPointer]

ConfidentialTransferMint
  authority                None
  auto_approve_new_accounts true
  auditor_elgamal_pubkey   None
```

That is ADR B1 exactly. With no authority the config can never change, so no
auditor can ever be set on this mint, by us or anyone. OnFinality's own
Token-2022 parser reads the account the same way.

The spike ran against it on 2026-09-28 with `SPIKE_MINT`: 4.2 wrapped USDC in
one 2,395-byte v1 transaction,
[`4hiDmtgT…yHgdPV`](https://explorer.solana.com/tx/4hiDmtgTyS4dhh37zje5cejKUGfRx32dBx5wgnpexrq2SLC5EusUgDq7Ba3sX7As9iyhQxLgyqSVUAKXcNyHgdPV?cluster=devnet),
the same size as on the spike's own mint. An unrelated RPC sees no amount, and
the recipient decrypts 4,200,000.
