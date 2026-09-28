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
