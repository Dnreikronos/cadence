# Confidential transfer spike

Issue [#46](https://github.com/Dnreikronos/cadence/issues/46). A throwaway
binary that does one confidential Token-2022 transfer on devnet and reads it
back through an RPC that had nothing to do with sending it.

It exists to test the one unproven assumption in the design — that a hidden
payment is a single transaction and an outsider sees ciphertext. Everything
else in Cadence is ordinary work.

## What it does

1. Creates a Token-2022 mint with `ConfidentialTransferMint`, auto-approve on,
   no auditor — or uses the one in `SPIKE_MINT`.
2. Creates and configures a sender and a recipient token account.
3. Funds the sender, deposits into the confidential balance, applies the
   pending balance.
4. Sends one confidential transfer — transfer plus equality, ciphertext
   validity and range proof, four instructions in one **v1** transaction — and
   prints the signature and the wire size.
5. Fetches that transaction from a second RPC provider with
   `maxSupportedTransactionVersion: 1` and prints what it can see of the amount.

## Running it

```bash
cd spikes/confidential-transfer && cargo test -- --nocapture
```

The test builds the real transfer with real proofs and measures it. No network,
no funded key. It is the half of the acceptance criteria that can be checked
anywhere.

```bash
cd spikes/confidential-transfer && cargo run
```

The full run needs a devnet keypair with about 0.2 SOL. On first run it writes
one to `devnet-payer.json` (gitignored) and prints the address; fund it at
<https://faucet.solana.com> and run again. The RPC `requestAirdrop` faucet is
usually dry.

| Variable | Default | |
|---|---|---|
| `SPIKE_KEYPAIR` | `./devnet-payer.json` | payer, generated if absent |
| `SPIKE_RPC_URL` | `https://api.devnet.solana.com` | sends the transactions |
| `SPIKE_VERIFY_RPC_URL` | `https://solana-devnet.api.onfinality.io/public` | reads the transfer back |
| `SPIKE_MINT` | unset | an existing mint to run against instead, such as the wrapped USDC in [ops/mint](../../ops/mint/README.md). The sender is funded from the payer's associated account for it, so wrap into that first |

A stock `solana-test-validator` will not work: it does not enable
`ZkE1Gama1Proof11111111111111111111111111111` and every proof instruction
fails. Devnet or Surfpool (ADR B4).

## Result

It works — 2,395 bytes, one v1 transaction, no amount field visible to an
unrelated RPC. The measurements, the dependency finding that contradicts ADR
B18, and the limits of the experiment are in the spike report:

**[One confidential transfer is 2,395 bytes on devnet, and `spl-token-client`
cannot send it](../../docs/dev/spikes/2026-09-27-confidential-transfer.md)**

That report is the deliverable. This crate is throwaway — except `src/v1.rs`
and `src/balances.rs`, which the proof service will have to absorb.
