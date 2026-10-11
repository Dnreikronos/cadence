# Transparent payment fallback (#60)

The proof service checks ZK ElGamal availability at startup when transfers are
configured and on every standalone transfer, payroll preparation, and eligible
payroll retry. It reads the executable program account and Agave's
`disable_zk_elgamal_proof_program` and `reenable_zk_elgamal_proof_program` feature
accounts in one confirmed `getMultipleAccounts` snapshot. Re-enabling overrides
the disable gate; a missing/non-executable program still selects fallback.
Malformed account data or RPC failures return `503 rpc_unavailable` rather than
selecting a privacy mode from incomplete evidence.

During an outage, the service prepares one ordinary Token-2022 `TransferChecked`
instruction per payment, on the existing wrapped-USDC mint. Transactions stay
unsigned v1 payloads with the company wallet as their only signer. Existing
authentication, exact-message confirmation, finalized indexing, signing order,
and safe retry rules apply. Fallback never loads a Vault key, rents proof contexts,
or acquires a proof-worker slot. The request's existing AES-key field is still
required and validated for API compatibility, but is unused by the public builder.

## Funding and destination policy

Keep a sufficient **public wrapped-token balance** in the sender account if
payroll must continue during an outage. Ordinary transfers spend that balance;
they cannot spend the encrypted available balance. Withdrawing encrypted funds
requires the unavailable proof program, so an outage cannot automatically convert
those funds into a public reserve.
See Solana's [public-balance behavior](https://solana.com/docs/tokens/extensions/confidential-transfer/integration-guide).

The company Deposit screen offers **Public payment reserve** alongside private
funding and displays the public wrapped-token reserve separately. It calls
`POST /wrap` with `mode: "public"`, creates the Token-2022 ATA if needed, enables
public credits on an existing confidential account when necessary, and wraps
ordinary USDC 1:1. It needs no confidential setup or ZK instructions. The response
uses `deposit_state: "public_after_confirmation"`; the flow stops after this
single transaction finalizes, without depositing or applying confidential credits.
Omitting `mode` preserves confidential funding. See [Wrap USDC](WRAP_API.md).

Both funding modes share one controller and the viewer's localStorage submission
record, including its funding mode. An unknown outcome retains the record and blocks
another deposit after retries or reloads. Elapsed time alone does not clear that
lock. A settled outcome clears it; after checking their balances and history,
the person can also explicitly release an unresolved deposit.

Source and destination must be initialized, unfrozen Token-2022 accounts of the
wrapped mint. The caller's wallet must own the source. A confidential destination
must allow non-confidential credits. `409 insufficient_public_balance` means the
reserve cannot fund a standalone payment; a payroll payment instead receives
`preparation_failed` with that error. Destination policy rejection uses
`non_confidential_credits_disabled`. Failed preparations do not reserve funds
from later payments in the run.

## Stored receipts and deployment

Apply `supabase/migrations/20261010000003_transparent_fallback.sql` after the
indexer and auditor migrations before deploying this service or the updated
frontend. It adds `transparent` to standalone receipts, payments, and
archived payment attempts, defaults historical confidential receipts to false,
and protects each attempt's mode from later changes. A verified failed attempt
may retry in the current mode; its old mode remains in `payment_attempts`.

Transfer prepare/confirm and every run payment response include `transparent`.
The frontend reads the run response's flag for the transparent badge and checks
public transfer accounts and amounts against the admin's approval before signing.
The authorized auditor API decodes the public transfer amount
directly, with no viewing-key lookup or decryption, while retaining company grants
and the committed read audit. There is no separate plaintext amount column.
The ordinary transaction itself exposes its amount on chain.

## Verification

`tests/fallback.rs` covers gate activation/re-enabling, missing programs, malformed
RPC responses, ownership and destination policy, frozen accounts, balance checks,
and public allocation across a batch. `tests/fallback_http.rs` uses a disposable
Supabase database and simulated Auth/RPC to complete a three-recipient public run,
confirm a standalone transfer, and retry a failed confidential payment during
an outage without erasing its old privacy mode. It runs in the CI Vault matrix.
These tests simulate finalized chain receipts; they do not send live payments.

The targeted auditor storage test also reads both public payroll and standalone
receipts after deleting every viewing key. The run storage test checks privacy
immutability and retained attempts. Signing tests reject public amounts,
accounts and privacy modes that differ from the approved payment. Wrap builder
and HTTP tests cover proof-free public funding for new and existing accounts. Frontend tests cover one-transaction
funding, reserve balance reads, safe recovery and preserved privacy mode.
The targeted `company-deposit.spec.ts` browser scenarios exercise both funding
choices, validation, private-flow failures and an unknown public deposit after
reload. Browser checks use mock wallets and receipts, not live funds.

```sh
cargo test --locked --test fallback
TRANSFER_TEST_DATABASE_URL=<empty-disposable-vault-database> \
  cargo test --locked --test fallback_http -- --ignored
```

Feature IDs are pinned to Agave's [feature-set source](https://github.com/anza-xyz/agave/blob/master/feature-set/src/lib.rs).
