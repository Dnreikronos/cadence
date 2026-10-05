# Squads can send confidential USDC; setup must bind the encryption key

Date: 2026-10-04 · Owner: João · Time box: none set; one working session
Verdict: go for direct vault payments; production integration remains pending.

A 2-of-2 Squads v4 vault sent 0.42 wrapped USDC confidentially on devnet in one
2,399-byte v1 transaction. Independent RPC reads confirmed the ciphertext and
decrypted balances. The PDA needs no private key: its token account uses separate
ElGamal and AES keys, while Squads supplies spending authority. Setup needs an
extra safeguard: approve a stored public-key proof context, because an inline
setup proof lets an executor substitute the encryption key.

## The question

[Issue #57](https://github.com/Dnreikronos/cadence/issues/57),
[ADR O3](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md),
and [PRD Q4](../../prd-confidential-usdc-payments.md) ask whether a Squads vault
can originate a confidential payment. The Company's $799/mo multisig claim
depends on the answer. The fallback was a transparent vault funding a separately
signed confidential payer; the direct result makes that fallback unnecessary.

## What we did

The [experiment contract and harness](../../../spikes/squads-confidential/README.md)
live in `spikes/squads-confidential/`. The deliverable is this finding; the code
is disposable and does not implement the product's multisig onboarding.

1. Checked both RPCs' full devnet genesis hash and the existing wrapped mint.
2. Created a 2-of-2 multisig with two distinct member keys, no configuration
   authority and no spending limits. Created an auxiliary token account owned
   by vault 0, with space for its confidential extension.
3. Wrapped 1 devnet USDC directly into that account. Proposed and approved an
   ordinary 0.1 wrapped-USDC transfer and checked both public balances.
4. Configured the vault account with an independently generated ElGamal
   keypair and AES key. The configuration ran through Squads CPI; its validity
   proof ran at the next top-level instruction.
5. Proposed and approved `Deposit` of the remaining 0.9 tokens, then
   `ApplyPendingBalance`. Checked the expected/actual credit counters and AES
   balance before building the payment.
6. Proposed the confidential transfer instruction, collected two approvals,
   and executed it with the three proof instructions at top-level offsets
   +1, +2 and +3. After one approval, simulation had to fail for every vault
   operation. After quorum, reordered proofs and proofs for 419,999 units also
   had to fail before the real 420,000-unit payment was submitted.
7. Read the payment and accounts through OnFinality, independently of the
   sending RPC. Decrypted the sender's available and receiver's pending
   balances, inspected the parsed CPI, and decoded its raw instruction.
8. On additional empty accounts, simulated an executor substituting a different
   valid key proof during setup. Then created a stored validity-proof context
   with the vault as close authority, approved configuration referencing that
   account, and confirmed the intended public key. An overwrite attempt against
   the initialized context was rejected.

The first run confirmed the payment, then hit OnFinality HTTP 429 during balance
verification. The read-only `verify` command resumed from the private checkpoint;
no second payment was sent. The observer script also retries rate limits.

Reproduction commands, funding requirements and checkpoint handling are in the
harness README. Public receipts and the observer result are committed in
[evidence.json](../../../spikes/squads-confidential/evidence.json); private
fixtures remain gitignored in `.runs/`, with secret files created mode `0600`.

| Environment | Version / value |
|---|---|
| Sending RPC | `https://api.devnet.solana.com` |
| Independent RPC | `https://solana-devnet.api.onfinality.io/public` |
| Rust / Node | 1.98.1 / 26.5.0 |
| Squads SDK / web3.js | 2.1.4 / 1.99.0 |
| Token-2022 interface | 3.1.2 |
| Proof generation / extraction | 0.6.1 / 0.6.1 |
| ZK SDK / proof interface | 7.0.1 / 0.1.3 |
| Message / transaction / wincode | 5.1.0 / 5.1.0 / 0.6.2 |

## What we measured

| Check | Result | n |
|---|---|---|
| Ordinary vault payment | 100,000 units credited publicly | 1 confirmed payment |
| Direct confidential payment | 420,000 units credited to recipient pending balance | 1 confirmed payment |
| Sender after confidential payment | 480,000 units available; recipient public balance remains 100,000 | 1 independent account read per side |
| Payment envelope | v1, 2,399 bytes, Squads execute plus three top-level proofs | 1 |
| Observer's token instruction | `confidentialTransfer`, CPI stack height 2, owner is the vault PDA | 1 parsed transaction |
| Amount visible in transfer instruction | No parsed `amount`; no little-endian 420,000 in its 169 raw bytes | 1 raw transaction |
| Execution after one approval | `InvalidProposalStatus`, Squads custom error 6008 | 6 rejected simulations |
| Reordered payment proofs | `InvalidInstructionData` | 1 rejected simulation |
| Different-amount payment proofs | `ConfidentialTransferBalanceMismatch`, Token-2022 custom error 27 | 1 rejected simulation |
| Inline setup with a different key proof | Accepted by simulation after quorum | 1 simulation; never executed |
| Setup referencing a stored proof context | Intended encryption key configured | 1 confirmed configuration |
| Overwrite initialized key proof context | `AccountAlreadyInitialized` | 1 rejected simulation |

The sample is one confidential payment, not a throughput or reliability study.

| Receipt | Explorer |
|---|---|
| Ordinary vault transfer | [2Kne8Z2Q…N94f5w](https://explorer.solana.com/tx/2Kne8Z2Q4MdjAxVdqmzHoi3FPvYRMcg4CgSwu522XpjDHERsX9bys2Yxb7g2PqicKQ1DqwoaKp4wfv4i6dN94f5w?cluster=devnet) |
| Confidential vault transfer, slot 507537434 | [4uST64fP…c92Jt](https://explorer.solana.com/tx/4uST64fP3eTW4WjDpRz78aR55eJXFNdYGiR94Sm73isXYQkkkKdNggSsaXttCsRWMnkGC5FSm3CZAcuVWnic92Jt?cluster=devnet) |
| Setup with a bound encryption key, slot 507539057 | [3c8M6YFK…b7rQ7b](https://explorer.solana.com/tx/3c8M6YFKbn9eJZ1Bu57PFWSzPkJN6LZRLkTBPSJ56vzBTwiBvVor9qgK6HL6KyTGvUCJ9o9NdXaLUCGmf9b7rQ7b?cluster=devnet) |

## Why the PDA works

The encryption key belongs to the token account's confidential extension; it
does not have to derive from the owner's signing key. The
[protocol overview](https://www.solana-program.com/docs/confidential-balances/overview)
describes this separation. Our vault account's public key and independent
ElGamal public key are both recorded in the receipts.

When executing an approved proposal, Squads reconstructs the stored token
instruction and calls
[`invoke_signed` with its vault seeds](https://github.com/Squads-Protocol/v4/blob/af94153ff77a28b6effe46b9c94baaa93742b48c/programs/squads_multisig_program/src/utils/executable_transaction_message.rs#L180).
Token-2022 sees its account owner as a signer inside that CPI. The outer fee
payer signs a transaction; nobody signs with a nonexistent vault private key.

Proof generation uses the independent encryption secret off chain. The token
instruction's offsets locate proof instructions through the transaction's
instructions sysvar, so replacing the top-level token instruction with Squads
execute preserves +1/+2/+3. The proof program verifies those statements in the
same outer transaction. Failure rolls the payment back atomically.

An executor cannot choose a different payment by substituting valid proofs:
Token-2022 checks their ciphertext against the approved transfer payload.
[The processor's ciphertext comparison](https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/program/src/extension/confidential_transfer/processor.rs#L691)
explains the custom error 27 observed in the different-amount simulation.

## Setup needs a bound key, unlike the payment's inline proofs

`ConfigureAccount` gets its key from a public-key validity proof, while the
stored token instruction contains the encrypted zero balance and a proof
location. It does not include the intended ElGamal public key. The
[configuration processor](https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/program/src/extension/confidential_transfer/processor.rs#L221)
therefore accepts another valid key proof at that location. The empty-account
simulation confirmed this; quorum alone did not bind the intended viewing key.

Create and verify a public-key proof context before proposing configuration,
then use `ProofLocation::ContextStateAccount` so the proposal commits to its
address. Our context was owned by the ZK proof program, rejected overwrite, and
named the vault as close authority. The confirmed configuration consumed that
context and installed the intended key. This adds an onboarding transaction,
without changing the single-transaction payment result. Do not ship the first
run's inline setup pattern as production enrollment.

The general prevention rule is to check what the approved inner instruction
actually commits to. Authorization of a token operation does not automatically
bind every statement supplied later by its executor.

## What the Company tier can promise

The planned Company integration can require a Squads quorum to approve each
confidential payment directly from its vault. It does not need a separately
controlled payer account. Funding, deposit amounts, participants and timing
remain public; individual confidential payment amounts remain ciphertext to
outsiders. Cadence still holds viewing capability under B17/B19.

This is a feasible planned feature, not shipped multisig support. Before selling
it, build enrollment with bound key proofs, encrypted persistence and recovery
for both ElGamal and AES keys, member-signed approval/execution, and an authorized
amount/recipient review screen. The single-wallet signature derivation used
elsewhere cannot recover a vault's randomly generated keys. Never collect
members' signing keys in the production proof service.

A transparent vault-to-payer fallback would make the funding amount public and
would put the subsequent payment under the payer's authority. It could promise
multisig treasury funding, not quorum authorization of each confidential
payment. That alternative was not run because the direct path succeeded.

## What this does not tell us

- Mainnet behavior, production member wallets or the Squads web app were not
  tested. Both member signing keys were local disposable fixtures.
- The successful payment used inline setup in the controlled fixture. Bound
  setup was confirmed separately on an empty account; a full payment from that
  second account was not run.
- Key recovery, account migration, closing proof contexts, concurrent pending
  proposals and production authorization rules need implementation and tests.
- Auxiliary accounts were used. ATA reallocation and a 100-recipient payroll
  remain separate work; O4 is unchanged.
- The npm audit reported 10 advisories in this research dependency graph
  (6 moderate, 4 high). These packages and local secret files are not a
  production integration or a key-storage design.

## Next

O3's feasibility question is answered. João owns the enrollment/recovery and
member approval integration before Company multisig is enabled. The
[ADR](../../decisions/2026-09-27-confidential-payroll-rail-architecture.md) and
[PRD](../../prd-confidential-usdc-payments.md) record the proven capability and
that remaining release condition.
