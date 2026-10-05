# Squads confidential transfer spike

Issue [#57](https://github.com/Dnreikronos/cadence/issues/57).
Owner: João · Date: 2026-10-04 · Status: direct devnet payment confirmed.

A 2-of-2 vault sent a confidential payment in one 2,399-byte v1 transaction.
Production setup must bind its encryption key through a stored proof context;
an inline setup proof is replaceable by the executor. See the
[finding and Company-tier limits](../../docs/dev/spikes/2026-10-04-squads-confidential.md)
and [public receipts](evidence.json).

## Experiment contract

Can a Squads v4 vault own a confidential wrapped-USDC account and originate a
payment approved by two members, while its encryption keys remain independent
of its PDA signing authority?

Use the existing [devnet wrapped USDC](../../ops/mint/README.md), a disposable
2-of-2 Squads multisig with no configuration authority or spending limits, and
the existing devnet payer. Check the devnet genesis hash before spending. Use
separate, locally generated ElGamal and AES keys for the vault account; never
attempt to derive a signing key for the PDA. Keep experimental secrets outside
Git and publish only addresses, signatures, wire sizes and balance assertions.

1. Read the mint and funding accounts before creating anything. Create the
   multisig and a vault-owned token account, fund it, and execute an ordinary
   wrapped-USDC transfer through a proposal with two distinct approvals.
2. Configure that account for confidential transfers through Squads. Test a
   public-key validity proof outside the Squads CPI, with the vault authorizing
   the configuration inside it. Read back the owner and encryption public key.
3. Deposit and apply a confidential balance through approved vault operations.
   Generate transfer proofs off chain and execute a vault payment. Simulate
   execution after one approval and require rejection before the second vote.
   Read the transfer through an independent RPC and decrypt the receiver's
   credit to check the amount.
4. If the direct path fails, preserve the exact failure and test an approved
   transparent transfer to a separately signed confidential payer. Record which
   actions remain subject to the multisig threshold and what becomes public.
5. Publish the evidence and limits, resolve or qualify ADR O3, and align the
   Company's $799/mo multisig claim with the result.

The verdict requires either a confirmed direct devnet payment or a documented
alternative with an explicit tier limitation. Compilation, static analysis,
targeted checks and local simulations are evidence, but cannot substitute for
a confirmed transaction. This is disposable research code, not a production
multisig integration.

## Running it

Run from this directory in the checkout. The Rust crate reuses balance, RPC and
v1 helpers from `spikes/confidential-transfer`, and the wrap builders from the
proof service. Node builds Squads instructions only; it receives no private keys.

```bash
npm ci --ignore-scripts
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo test independent_keys
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo check
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo clippy --all-targets -- -D warnings
rtk npm run check
rtk npm run lint
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo run
```

The default run requires at least 0.1 devnet SOL and 1 devnet USDC in the
payer's USDC ATA. It wraps that USDC directly into the new vault account. Each
default run creates a fresh multisig and consumes another 1 devnet USDC.

| Variable | Default |
|---|---|
| `SQUADS_KEYPAIR` | `../confidential-transfer/devnet-payer.json`, must already exist |
| `SQUADS_RPC_URL` | `https://api.devnet.solana.com` |
| `SQUADS_VERIFY_RPC_URL` | `https://solana-devnet.api.onfinality.io/public` |

The two RPCs must be different devnet endpoints. The output prints a run
directory. Each run saves public receipts and mode-0600 private checkpoints
under gitignored `.runs/`; keep those to recover the disposable accounts.
Never commit `secrets.json` or `setup-secrets.json`.

After a confirmed payment, resume verification without sending again, and run
the empty-account setup probe once for that fixture:

```bash
SQUADS_RUN=".runs/<address printed by cargo run>"
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo run -- verify "$SQUADS_RUN"
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo run -- probe-setup "$SQUADS_RUN"
RUSTUP_TOOLCHAIN=1.98.1 rtk cargo run -- verify-setup "$SQUADS_RUN"
```

`probe-setup` creates empty accounts, demonstrates key substitution by
simulation, and confirms a configuration using a stored proof context. It leaves
the unsafe inline-setup proposal unexecuted on an empty account. `verify-setup`
simulates an overwrite attempt against the bound context without sending it.

An unrelated observer can check the committed payment receipt with no keys:

```bash
node verify.mjs evidence.json
```

Local targeted tests cover independent-key proof generation, SDK construction
of a PDA-owned account proposal, and private checkpoint recovery. The live
run additionally checks quorum, ciphertext/proof binding and decrypted balances.
