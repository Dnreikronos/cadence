# One confidential transfer is 2,395 bytes on devnet, and `spl-token-client` cannot send it

Date: 2026-09-27 · Owner: João · Time box: TODO(João): none was set; spent one working session
Verdict: **go**, conditional on superseding [B18](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md). The primitive works exactly as [B2](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md) and [R3](../../prd-confidential-usdc-payments.md) assume. The Rust client B18 names to build it cannot.

## The question

[Issue #46](https://github.com/Dnreikronos/cadence/issues/46). Does a Token-2022 confidential transfer confirm as a single transaction under 4,096 bytes, and does the amount come back from an unrelated RPC as ciphertext?

Everything else in Cadence is ordinary work — a dashboard, a Postgres schema, RLS policies. This is the one place the design could have been wrong about what the chain does, and the whole product rests on it. Stated pass/fail, from the [PRD](../../prd-confidential-usdc-payments.md):

- **R3** — the payment resolves to one confirmed transaction under 4,096 bytes, not a chain.
- **R2** — a third-party RPC shows ciphertext.

## What we did

`spikes/confidential-transfer/` — a throwaway binary. **None of that code is meant to survive.** It exists to produce the numbers below; the two modules worth reading before the service is written are called out under *What we learned*.

Five steps, every one of them sent as a transaction v1 against devnet:

1. A Token-2022 mint carrying `ConfidentialTransferMint` — `auto_approve_new_accounts: true`, auditor `None`. The extension instruction has to precede `InitializeMint2`, which is what freezes the extension set.
2. Two auxiliary token accounts sized for `ConfidentialTransferAccount`, each configured with its pubkey validity proof in the same transaction. Auxiliary rather than associated: an ATA is sized from the mint's extensions alone and has no room for the account extension.
3. `MintToChecked` + `Deposit` in one transaction, then `ApplyPendingBalance` in a second, with the account re-read in between to get the credit counter. Two transactions by choice, not by necessity — see the counter finding below.
4. One `Transfer` with its equality, ciphertext validity and range proofs inline at instruction offsets 1, 2 and 3. Four instructions, one transaction.
5. `getTransaction` with `encoding: jsonParsed` and `maxSupportedTransactionVersion: 1`, against a *different* RPC provider from the one that sent it. R2 is only demonstrated by an endpoint with no part in the send.

ElGamal and AES keys are derived per account from a wallet signature over the account address (`derive_confidential_keys`), so nothing has to be stored to recover them.

To rerun:

```bash
cd spikes/confidential-transfer && cargo test -- --nocapture   # size only, no network
cd spikes/confidential-transfer && cargo run                   # full devnet run
```

The test builds the real transfer with real proofs over a synthetic balance and measures it, so the size claim is checkable with no funded key and no network. `cargo run` needs a devnet keypair with ~0.2 SOL; it writes one to `devnet-payer.json` on first run and prints the address.

Environment, since none of these numbers are portable across versions:

| | |
|---|---|
| Cluster | devnet, `solana-core` 4.3.0, feature set 3383571666 |
| Toolchain | `rustc` 1.98.1 |
| Sending RPC | `api.devnet.solana.com` |
| Verifying RPC | `solana-devnet.api.onfinality.io/public` |
| Crates | `spl-token-2022-interface` 3.1.2, `spl-token-confidential-transfer-proof-generation` 0.6.1, `-proof-extraction` 0.6.1, `solana-zk-sdk` 7.0.1, `solana-message` 5.1.0, `solana-transaction` 5.1.0 |

## What we measured

| What | Result | How |
|---|---|---|
| Transaction version | 1 | as reported by the verifying RPC |
| Wire size | **2,395 bytes** | `wincode::serialize` of the signed transaction |
| Against the v1 cap | 4,096 | SIMD-0296 |
| Against the legacy cap | 1,232 | it would not have fit; v1 is load-bearing, not a convenience |
| Instructions in the transaction | 4 | transfer, equality, ciphertext validity, range |
| Amount as a third party gets it | 2 × 64 bytes of ElGamal ciphertext | `transfer_amount_auditor_ciphertext_lo` and `_hi`, read out of the raw instruction |
| Plaintext amount anywhere in the instruction | none | no `amount` field parsed, and no little-endian 4,200,000 in the 169 raw bytes |
| Amount visible to the recipient | 4,200,000 units | ElGamal decrypt of their pending balance |
| Successful transfers | n = 1 | |

The 2,395 figure is the same number in `cargo test` and on chain, to the byte. It is **smaller** than the 2,897 the ADR quotes for the Foundation's reference transaction, mostly because v1 carries the compute budget in the message config rather than in two `ComputeBudget` instructions.

The run:

| | |
|---|---|
| Transfer | [`5hhrC9Ec…A99WxT`](https://explorer.solana.com/tx/5hhrC9EcF77nAmRCLf3CnqFMxvAr9MpzAgoDtvGMRzUr4LsauiD2kXM2DVvDZmgWzJshSiY2vitkp7DeUbA99WxT?cluster=devnet) |
| Slot | 504918144 |
| Mint | `DNwfK2HrZBYZyQQXtTxdRqYaKjSixWUrBbb9CVLrSa4u` |
| Source | `DjzzcxJfjcZvsY8AXuJTrRy7QS43Yj1Nbf3PYpLU4UXC` |
| Destination | `DYi3gDbtQkrS63cGGbkdDNvWAFkPY1FHjXvUZcNQ3J5C` |
| Amount | 4,200,000 units of a 6-decimal token |

Fetched back from OnFinality, the transfer parses to this and nothing more:

```json
{
  "type": "confidentialTransfer",
  "info": {
    "source": "DjzzcxJfjcZvsY8AXuJTrRy7QS43Yj1Nbf3PYpLU4UXC",
    "destination": "DYi3gDbtQkrS63cGGbkdDNvWAFkPY1FHjXvUZcNQ3J5C",
    "owner": "DLk4sKdCznkrXX7QP51vQEcLRtgTuTv5P3pG86kKo1cY",
    "newSourceDecryptableAvailableBalance": "0ja2ctGcJYE+T8mhmpIT+L8h2fgUazKofrJo2RZybOW11x0I",
    "equalityProofInstructionOffset": 1,
    "ciphertextValidityProofInstructionOffset": 2,
    "rangeProofInstructionOffset": 3
  }
}
```

Addresses, yes. Where an ordinary SPL transfer carries `"amount": "4200000"`, the parsed view has no amount field at all.

That absence is not the same as the amount being ciphertext, so the spike also pulls the instruction back unparsed from the same RPC. The 169 bytes are exactly `TransferInstructionData` — two discriminants, the sender's 36-byte AES balance, then `transfer_amount_auditor_ciphertext_lo` and `_hi` at 64 bytes each, then the three proof offsets. Those two are the transfer amount, encrypted. The little-endian `4200000` a transparent transfer would carry is not anywhere in the 169 bytes, and the run checks for it.

One wrinkle, since the mint has no auditor. The second half of each of those ciphertexts is the decrypt handle under the auditor key, and with no auditor that key is the default, so the handle comes back as 32 zero bytes. The first half is still a Pedersen commitment to the amount and still hides it. Nobody can read the amount from these, which is what R2 needs — but do not read them as evidence that an auditor *could*. That is R4 and it is untested here.

The recipient's own key decrypts their pending balance to 4,200,000 in the same run.

## What we learned

**`spl-token-client` cannot build this transaction, and it cannot be kept around for the other steps either.** Release 0.19.1, the current one, assembles the right four instructions in `confidential_transfer_transfer` and then hands them to a legacy `Transaction` through `solana-message` 3.x — a 1,232-byte container for a 2,395-byte payload. Nor is a split possible where the client does setup and we hand-build only the transfer: v1 needs `solana-message` 5.x, which requires `solana-hash` `4.7.0`; the only `solana-rpc-client` release that agrees with `spl-token-client` 0.19 on the `Transaction` type is 4.0.0, which pins `solana-hash` to `~4.2.0`. Both sit in Cargo's 4.x compatibility range, so one build cannot contain both. The spike therefore depends on the client not at all.

What survives of B18 is the part that mattered. Proofs still come from `spl-token-confidential-transfer-proof-generation` — the same crate `spl-token-client` itself calls — and instructions from `spl-token-2022-interface`. Nothing cryptographic is hand-rolled. What *is* ours, and what the proof service will have to own until upstream ships a v1-aware client, is two small modules: `src/v1.rs`, about eighty lines of message compilation and signing, and `src/balances.rs`, the bookkeeping around reading and re-encrypting a confidential balance.

**A v1 message defaults every budget field it does not carry to zero**, where a legacy transaction got 200k CU per instruction and a 64 MiB account-data allowance for free. This cost real time in the spike: the account-data one fails simulation with `MaxLoadedAccountsDataSizeExceeded`, which reads like the transaction is too large and is nothing of the kind — the declared allowance was zero and the Token-2022 program account alone exceeds it. Whatever wraps transaction assembly in the service should set both centrally, because a call site that forgets fails in a way that points at the wrong problem.

**`ApplyPendingBalance` does not validate the credit counter it is given.** The instruction takes an expected counter, which reads like a guard and is not one. The program folds in whatever pending balance exists when it runs, stores the AES balance it was handed, and writes the expected and actual counters into two separate fields. Comparing them is the caller's job, after the fact. A credit landing in flight therefore produces a transaction that succeeds while leaving the AES balance out of step with the ElGamal one, and the damage only surfaces later as a proof that will not verify. `balances.rs` exposes the comparison and the flow stops on it, but a service doing this at payroll volume needs a real resync path, not a stop.

A side effect worth knowing: since nothing is validated, deposit and apply *can* go in one transaction. You know the counter will be current plus one and you know the resulting balance, so neither has to be read back. This spike keeps them apart because it is easier to follow, not because it has to.

**Two `solana-instruction` majors have to coexist.** Token-2022 emits 3.5.1, `solana-message` 5.x consumes 4.0.0. The structs are field-identical and a nine-line copy bridges them. Harmless, and it resolves itself when Token-2022 moves up.

**The public devnet endpoint rate-limits `getSignatureStatuses`** into 429s within roughly five transactions at a 500ms poll interval. A failed poll is not a failed transaction, and treating it as one aborts a run that in fact succeeded. Backing off to 1.5s and retrying on error was enough here; the service wants a paid endpoint.

**Devnet's `requestAirdrop` is effectively unavailable** — 429 from `api.devnet.solana.com` across repeated attempts, and the free third-party endpoints either require an API key (Ankr), exclude devnet from the free plan (dRPC), or return nothing. Anything running this in CI needs a pre-funded key.

## Verdict

**Go.** R2 and R3 both hold, on chain, from an unrelated observer's view. The amount comes back as two ElGamal ciphertexts with no plaintext beside them, which is the criterion, and the transfer is one v1 transaction well inside the cap. B2's single atomic transfer is real and B7's `maxSupportedTransactionVersion: 1` is not optional — it is what makes the reading half work.

Conditional on one thing: **B18 has to be superseded.** It names a client that cannot build the transaction it was chosen for. The replacement is not a different library, it is an accepted cost — the proof service owns transaction assembly and balance bookkeeping itself, using library proofs, until upstream catches up. That is a decision for João, not a finding of this spike; see *Next*.

## What this does NOT tell us

- **Nothing about the auditor.** The mint was created with no auditor key, so R4 is untouched. Deliberate: [O1](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md) — shared mint with app-level grants, or a mint per company — is undecided, and the spike should not prejudge it.
- **Nothing about associated token accounts.** These were auxiliary accounts created at the size the extension needs. An ATA is sized from the mint's extensions alone and needs a reallocate first. The product has to solve that; this did not.
- **Nothing about `token-wrap`.** The mint here is a bare Token-2022 mint, not a wrapped USDC mint created through `token-wrap` as [B1](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md) specifies. The confidential instructions are the same; whether `token-wrap`'s immutable `auditor: None` forces a fork is still an O1 question.
- **Nothing about cost or throughput.** n = 1, one recipient, one transfer. [O4](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md) — proof generation time at a 100-recipient run — is untouched, and it is a different measurement on different hardware.
- **Nothing about mainnet.** Devnet, against a wholly disposable mint. Devnet and mainnet are on the same feature set for this, but fee markets and RPC behaviour are not comparable.
- **Nothing about Squads.** O3 stands.

## Next

- Supersede B18 in the [decision log](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md), and correct B2's 2,897 bytes to the measured 2,395. Owner: João.
- Fold `src/v1.rs` and `src/balances.rs` into the proof service when it is written, with the budget fields set in one place. The rest of the spike is throwaway.
- Provision a paid devnet RPC endpoint and a pre-funded key before anything depends on this in CI.
