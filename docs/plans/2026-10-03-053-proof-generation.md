# Proof generation module

Issue: https://github.com/Dnreikronos/cadence/issues/53.

## Contract

Add `solana::confidential` without an HTTP endpoint. The pure builder receives
trusted RPC snapshots of the mint and sender/recipient token accounts, the
sender's already-loaded `ViewingKey`, a borrowed AES balance key, amount in base
units, recent blockhash, and rent quotes for the three proof-context sizes.
It returns an unsigned v1 transaction. The service never receives a wallet
signing key. A small async entry point loads `ViewingKey` through
`keys::vault::load` with trusted actor/reason before calling the pure builder.

The current Vault format retains only the ElGamal secret. Accept the separate
AES balance key transiently from trusted calling code; do not persist it,
derive a replacement, or change enrollment/storage in this issue. Future
transfer routing owns authentication, fresh RPC reads, AES-key delivery,
timeouts, blockhash retries, and submission. The pure builder must not fetch
accounts, sign, submit, log, or persist plaintext amounts or keys.

Validate Token-2022 ownership, initialized/unfrozen accounts, matching mint,
sender ownership and ElGamal public key, confidential approval, recipient credit
capacity, valid amount, and supported mint extensions. Reject transfer fees and
hooks rather than silently omitting their required behavior. Derive destination
and optional auditor ElGamal keys from the supplied on-chain snapshots.

Generate equality, ciphertext-validity, and U128 range proofs through the
unchanged `spl-token-client::zk_proofs::confidential_transfer::TransferAccountInfo`
helpers. Use SDK/interface encoders for every proof and transfer instruction;
no custom cryptography. Re-encrypt the reduced AES balance with the same helper.

Create three seeded context accounts with the wallet as base and close authority.
Derive distinct seeds from freshly randomized public proof bytes, so no temporary
signing key or reusable context account is required. Verify each proof into its
context, reference those contexts in the transfer, and close all three back to
the fee payer in the same transaction. All ten instructions compile together
with the existing centralized v1 budgets. Any failure rolls back the transfer
and rent movements. Enforce a serialized size strictly below 4,096 bytes before
returning; return fixed error descriptions without amounts or upstream payloads.

## Verification

Run formatting, compiler, Clippy, and targeted confidential/compatibility tests.
Cryptographically verify all three generated proofs, extract and compare their
joint transfer context, decrypt recipient ciphertext and the sender's updated
balance, and reject tampered/mismatched proof data. Check creation/verification/
transfer/close ordering, signer requirements, rent destinations, unsigned wire
round trips, the size bound, and caller-side wallet signing. Cover insufficient
funds, malformed/mismatched keys and balances, invalid account/mint states, and
recipient capacity. Verify the audited loading path against disposable Vault.

Use a disposable devnet mint and externally-held funded test wallet to exercise
the actual module, sign its output, submit one transaction, verify confirmation,
decrypt the recipient's credit, and confirm all context accounts are gone.
No production funds, hosted migration, or transfer HTTP route is in scope.
Record live evidence separately from local tests and prior spike results.

## Local evidence

Formatting, `cargo check --locked --all-targets`, and
`cargo clippy --locked --all-targets -- -D warnings` passed. The existing
vendored deprecation warning remains. The targeted tests cover all three
proofs, ciphertext decryption, the optional mint auditor, bad account states,
fees/hooks, amount bounds, wrong AES keys, and a stale AES balance. The pinned
SDK already rejects a mismatch between the AES and ElGamal balances during
proof generation; the regression test ensures that behavior stays covered.
The compatibility tests still pass. No full suite or remote CI run is claimed.

The ignored `confidential_vault` test passed against fresh disposable Supabase
Postgres 17.6.1.143 with Vault 0.3.1. It proves successful audited loading and
transaction building, audit retention after failed proofs, and failure before
key access when attribution is missing or audit persistence fails. CI runs the
existing `keys` test and this test as separate matrix jobs, each with an empty
Vault instance. Workflow YAML and the matrix configuration were checked locally.

On 2026-10-03, a temporary, amount-safe copy of the devnet spike used the actual
`load_and_build` entry point, with fresh RPC snapshots, real rent quotes, and
the key enrolled in disposable Vault. The test wallet signed only after the
module returned. The resulting **2,913-byte v1 transaction** confirmed at slot
**507067969**, using **247,976 of the 400,000 declared compute units**:
[devnet transaction](https://explorer.solana.com/tx/4RBcwtH9rR8bqof63N1bnjudBLAyR95FkjZWRM4ys5Nt3B7brwG6oaetBGuSJSKYywRrZJW9CUKMrXVhWsiUm7Ta?cluster=devnet).

All ten instructions executed together. The harness verified the sender debit,
recipient credit, and absence of all three context accounts after confirmation.
The Vault audit row was read back independently. An OnFinality `getTransaction`
read declared `maxSupportedTransactionVersion: 1`, reported success and v1,
and showed no plaintext amount field in the parsed confidential transfer.
This used a disposable Token-2022 mint and an external test wallet; browser
signing and the transfer HTTP route remain #54. The temporary harness lives at
`/tmp/cadence-proof53-devnet` on the development machine, outside the repository,
and is evidence for this run rather than a maintained devnet test suite.
