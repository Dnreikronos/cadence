# Web app backend contract implementation

Issue: [#63](https://github.com/Dnreikronos/cadence/issues/63).
Status: backend implementation complete locally; migrations are not deployed. The user accepted these requirements on
2026-10-11. Ownership is backend/web3 only; frontend code and mocks are outside
this implementation.

## Requirements and decisions

Keep positional `/runs`, batch confirmation, and evidence-based reconciliation.
Require company-admin membership and verified wallet ownership before preparing
or retrying company payroll. Ownership authorization precedes wallet quotas.
Require `allow_transparent: true` to prepare a public fallback; omission means
confidential-only. Apply the same consent gate to standalone transfer and retry.

Add owner-scoped UUID `idempotency_key` on run creation. Serialize creation for
each owner in PostgreSQL across processes and commit the run and payments
atomically. Reusing a key recovers the original signing payloads without building
proofs again. The original committed request wins: keys cannot change wallet,
sender or ordered destinations; amounts are never persisted or hashed for
comparison. Add paged run listing and explicit signing-payload recovery. Recovery
never renews an expired transaction or creates a replacement attempt. Unknown
outcomes remain prepared and blocked until verified finalized evidence arrives.

Expose validated token-account mappings, including auxiliary accounts. Clients
must never guess a company's source account. Recipient mappings remain null
until enrollment and on-chain confidential configuration are verified. Map the
canonical ATA for new accounts, but allow an existing owned wrapped-mint account
to be explicitly registered. A user may only enroll or register their own wallet
and account, with verified Supabase identity and wallet-link proof.

Return the SDK's exact account-specific derivation message as base64. Enrollment
accepts a separate derivation signature, verifies it, and stores ElGamal material
through the existing encrypted Vault accessor. Never store the signature or AES
key in ordinary tables. Authorized GET balance reads require the AES key, so
enrollment stores it as encrypted Vault material behind the same committed audit
gate as ElGamal. Existing payment builders still accept transient AES inputs;
account updates load the canonical derived keys from Vault. Setup artifacts are
derived from the enrolled keys in backend proof workers; do not substitute temporary keys.

Implement configure/apply-pending prepare and confirm, account status, finalized
private balance reads, owner/company payment history, encrypted roster amounts,
and company/recipient/auditor CSV export. Reuse the strict transaction envelope,
signature verification, submitted-signature retention, shared proof concurrency,
devnet guard, fixed errors and dedicated database roles. Every private read must
commit its audit attribution before decryption, and every success/error response
from sensitive routes is `Cache-Control: no-store`. Amounts occur only in
authorized success responses, transient request memory and encrypted storage.

CSV uses integer six-decimal USDC formatting, RFC 4180 quoting and CRLF, formula
neutralization on all text fields, attachment and nosniff headers. Pagination is
bounded and uses stable UUID cursors. Exports must either return a complete
bounded snapshot or fail explicitly; never silently truncate.

## Phases

1. Run authorization, consent, durable idempotency and payload recovery.
2. Standalone transfer consent and matching HTTP/storage regression fixtures.
3. Account mapping, canonical derivation message and authenticated key enrollment.
4. Confidential configure/apply builders and durable prepare/confirm routes.
5. Audited balance, payment and encrypted roster reads/writes.
6. CSV routes, contract reconciliation and backend integration verification.

Each phase changes at most five files before verification. Add focused files
instead of restructuring large existing modules. Preserve pre-existing local
wrap/indexer/auditor/fallback work. Do not commit, push, deploy or edit frontend.

## Verification

Run compiler, formatting, Clippy and targeted tests after each phase. Run
disposable database tests for grants, transaction atomicity, concurrent create,
authorization, key enrollment, encrypted storage and audited read gates. Exercise
HTTP prepare/confirm against controlled RPC responses and inspect the encoded
transactions; test uncertainty without treating RPC absence as nonexecution.
Record commands and results here. Human frontend/backend contract sign-off stays
separate from the implementation results.

## Implementation and verification outcome

All six phases are implemented. The service registers 39 HTTP method/path pairs.
Existing local work was preserved, and this implementation made no frontend
edits. Five new migrations reuse the existing transfer, key, audit and indexer
runtime roles. The Vault fixtures enforce ciphertext at the heap boundary.

Locally executed final checks:

| Check | Outcome |
| --- | --- |
| `cargo check --locked --all-targets` | Passed. |
| `cargo fmt --check` | Passed. |
| `cargo clippy --locked --all-targets -- -D warnings` | Passed; the vendored token client's existing deprecation warning remains. |
| Targeted HTTP/auth/transaction/CORS/builder tests across 22 integration-test targets | 49 passed; nine database-dependent tests were ignored by the default invocation. |
| `cargo test --locked --lib routes::` | Five passed; unrelated library tests filtered out. |
| Explicit disposable Supabase database runs | Eight scenarios passed: `runs_recovery`, `accounts_http`, `owner_reads_http`, `fallback_http`, `indexer`, `audit_storage`, `transfer_http`, `unwrap_http`. Each suite used a reset fixture and the relevant migrations. |
| Documentation checks | Local links and 27 JSON examples valid; `git diff --check` passed. |

The database tests cover concurrent creation, original-payload recovery,
admin/wallet denial, overlapping unresolved destinations, separate wallet-link
and canonical derivation signatures, encrypted ElGamal/AES enrollment, durable
configure/apply receipts, finalized readiness, incoming/outgoing ciphertext
reads, encrypted roster storage, committed audit gates, CSV grant denial and
complete-export bounds, public consent, and indexer success/failure recovery.
The CI Vault matrix includes the three new database suites.

Self-review corrected two important boundaries: readiness must use finalized
account state, and a credit-counter mismatch must block private balance reads
instead of presenting the stale AES copy. Both have targeted regression coverage.
Read-worker concurrency permits stay alive until CPU work exits, including after
an HTTP timeout.

The full test suite was not run. No hosted migrations, live-chain transactions,
commit, push or PR were performed. Frontend integration/mocks and the issue's
human frontend/backend sign-off remain with their owners. Automatic cancellation
of unresolved transactions and CSV filters remain explicitly outside this first
release; unknown outcomes are kept blocked. The current API and deployment
instructions are in [WEB3_API.md](../dev/WEB3_API.md).


## Follow-up: status compatibility and live protocol validation

Accepted on 2026-10-11 after the browser validation findings. Keep the scope
backend/web3 and preserve all existing local work.

Return `wallet_linked` alongside `wallet_created` from the same verified account
mapping. Return `pending_credits` as `pending_credit_counter > 0` from the same
finalized account snapshot. Both fields are false when no mapping exists.
Do not add stored flags or change the existing response fields/readiness rules.
Cover unmapped, mapped/unconfigured, configured with pending credits, and applied
states in the targeted account HTTP/database regression test.

Retain null roster amounts for unset values and nullable payment counterparty IDs
when no linked identity exists. Add an explicit frontend integration handoff with
these semantics, canonical enrollment and positional recovery/confirm routes.
This follow-up does not edit frontend code or its mocks.

Validate backend protocols with isolated devnet test wallets and the local
Supabase fixture: canonical discovery/enrollment, unsigned configure and durable
confirmation, pending balance application and durable confirmation, run creation
recovery/original bytes and uncertainty blocking, and explicit fallback consent.
A controlled RPC availability fixture may simulate only proof-program availability;
transaction submission, finalized receipts, and account/balance reads must remain
real devnet observations. Record that distinction. Never synthesize chain success
or refresh an unknown transaction. Keep generated secrets in ignored local files.

Run compiler, formatter, Clippy and targeted account tests. Record live harness
results separately from the existing browser gate; do not claim frontend E2E
passes for protocol-only checks. Preserve failure evidence and owned-fixture
cleanup, stop only newly started processes, and perform no commit/push/deployment.


Follow-up outcome: compatible status booleans and a frontend integration handoff
are implemented. The existing frontend status schema accepts actual admin and
recipient API responses. Targeted tests: four ordinary checks and one explicit
Vault database lifecycle passed; compiler, formatter and Clippy passed. Three
live protocol flows passed cleanly (configure/activation, confidential payroll
recovery/confirmation, apply-pending/confirmation). Controlled fallback denial,
standalone public transfer and public payroll settlement were observed, including
exact finalized wire bytes and 1500 recipient public units. That flow remains
advisory/unstable because its composite test encountered two transient 503s.
The expired local wrap-role JWT was a separate corrected fixture prerequisite.
No accepted assertion was relaxed; failed attempts and supplemental settlement
checks are retained in the local follow-up report; the [published validation note](2026-10-12-063-backend-validation.md) records the later rerun.
These protocol results do not relabel the earlier browser failures as passing.
No frontend edits, hosted migration/deployment, commit or push were performed.
