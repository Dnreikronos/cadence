# Payment runs (#55)

Runs reuse the [transfer API](TRANSFER_API.md), its Supabase authentication,
wallet association and two restricted database connections. Apply
`supabase/migrations/20261003000001_runs.sql` after the transfer migration.
No new credentials are required. Missing configuration returns
`503 run_storage_unavailable`.

The company wallet is the sole signer. Source/recipients must be configured
Token-2022 accounts for the devnet wrapped-USDC mint. The sender needs an enrolled
viewing key and an applied available balance. Amounts and the 16-byte AES key
remain transient. One audited source-key read covers each batch build, attributed
to the verified user. The backend never signs or submits transactions.

## Prepare

Send `Authorization: Bearer <Supabase access token>` to `POST /runs`:

```json
{
  "company_wallet": "<wallet public key>",
  "sender": "<source token account>",
  "aes_key": "<base64 balance key>",
  "wallet_signature": "<wallet association signature, first request only>",
  "payments": [
    {"recipient": "<first token account>", "amount": "1000000"},
    {"recipient": "<second token account>", "amount": "2000000"},
    {"recipient": "<third token account>", "amount": "3000000"}
  ]
}
```

Accept 1–100 distinct recipients and decimal base-unit strings in 1..2^48−1.
Recipients are token accounts, not wallets. Malformed amounts, duplicate
recipients and transfers to the source are rejected before RPC work.

The response contains `run_id` (UUID), `company_wallet`, `sender`, `mint`,
`transaction_version: 1`, `required_signers: [company_wallet]`, aggregate
`status`, and ordered `payments`. Each prepared payment contains:

```json
{
  "position": 0,
  "destination": "<recipient token account>",
  "attempt": 0,
  "request_id": "<SHA-256 of unsigned wire bytes>",
  "status": "prepared",
  "signature": null,
  "slot": null,
  "error": null,
  "transaction": "<base64 unsigned v1 transaction>",
  "last_valid_block_height": 123
}
```

The recent blockhash is in the serialized message. Every transaction is below
4,096 bytes and contains atomic proof creation, verification, transfer and
context closes. No response contains an amount or key. A missing/unusable
recipient, individual RPC failure or proof failure returns `preparation_failed`
for its position, with a fixed error and no transaction. Other payments prepare
without debiting the predicted sender for the failed preparation.

## One approval and signing order

Show the full intended run once and obtain approval. Within the wallet session,
sign and submit prepared transactions in ascending position, waiting for
finalized execution before submitting the next. Retain every original prepared
transaction and its wallet signature, including signed but unsubmitted attempts.

Proofs bind to the sender's exact encrypted balance. Each payment assumes that
preceding prepared payments succeeded. If one fails, stop sending later stale
transactions and reprepare unpaid positions in the same run. Refreshing proofs
and blockhashes under the original approval lets payments with verified failures
continue. Long runs may outlive their blockhash. An expired attempt with missing
history stays unresolved and cannot be automatically rebuilt. Never edit the
returned message or start a second run for recipients who might already be paid.
Wallet session
management and the approval UI belong to #83/#77.

## Confirm and read

`POST /runs/:id/confirm` accepts any subset of up to 100 distinct positions:

```json
{
  "payments": [
    {"position": 0, "request_id": "<attempt request ID>", "signature": "<transaction signature>"},
    {"position": 1, "request_id": "<attempt request ID>", "signature": "<transaction signature>"}
  ]
}
```

Both chain successes and failures require the exact prepared message, sole
expected signer and valid wallet signature. Reads use finalized base64
transactions and `maxSupportedTransactionVersion: 1`. Success becomes `finalized`;
a chain failure becomes `failed` with `error: "transaction_failed"`. Both retain
signature and slot. Recorded terminal confirmations are immutable and idempotent
without another RPC read.

HTTP 200 returns updated metadata. Individual pending/mismatched/invalid
signatures or RPC/storage errors appear in optional
`errors: [{position, error}]`. They leave that payment unresolved and do not
prevent other receipts from being recorded. Each receipt must be committed
before it appears in the response. Whole-run auth/read errors remain HTTP errors.

`GET /runs/:id` returns ordered metadata without transaction/expiry payloads,
amounts or keys. Other users receive `404 run_not_found` on read, confirmation
and retry. Aggregate status is `completed` when all payments finalized,
`partial_failure` when any payment failed/expired/could not prepare, and otherwise
`prepared`.

## Retry unpaid positions

`POST /runs/:id/retry` resupplies the transient AES key and intended amounts:

```json
{
  "aes_key": "<base64 balance key>",
  "payments": [
    {"position": 1, "amount": "2000000"},
    {"position": 2, "amount": "3000000", "signature": "<original attempt signature>"}
  ]
}
```

Include all still-prepared positions; each requires its original valid wallet
signature, even if never submitted. The service observes finalized block height
before reconciling signatures. Landed successes are recorded and excluded from
re-preparation. Finalized failures can retry. A missing transaction before expiry
returns `409 transaction_not_finalized`. After expiry it returns
`409 transaction_history_unavailable` and leaves the original attempt prepared.
A null [transaction lookup](https://solana.com/docs/rpc/http/gettransaction)
does not prove that a payment never executed. Automatic recovery of expired,
unsubmitted attempts is also blocked because this RPC contract cannot prove
nonexecution. Restore finalized history for reconciliation; never start a second
run for a recipient whose payment remains unresolved.

Preparation failures need no signature. Positions/recipients stay fixed; callers
resupply approved amounts because no plaintext intent is stored. Retry builds
against fresh sender state, keeps finalized payments, increments `attempt` and
archives the replaced terminal attempt. Concurrent retries cannot replace the
same attempt twice. Execute returned transactions in ascending position again.

## Storage, limits and verification

`runs`, `payments` and `payment_attempts` have RLS and no amount/key columns.
The receipt role cannot delete history, access Vault or change finalized
payments. Anonymous/broad service-role clients have no access. Authenticated
users may read their own runs/payments under RLS and cannot write them. Company
membership and recipient/auditor read models remain separate work.

Runs share 120 requests/minute per process, 30 per direct peer, eight concurrent
HTTP requests, ten preparations/retries per wallet per minute and a 32 KiB body
limit. Recipient accounts are fetched with up to eight concurrent RPC reads,
preserving payment order and individual errors. Runs acquire a shared proof
permit after the RPC reads, immediately before audited Vault access. Runs and
`/transfer` share four CPU proof workers. HTTP work has a
30-second limit; timed-out workers retain permits until completion. Existing
`transfer_rate_limited` and `transfer_timeout` codes apply to runs. Forwarded
headers do not choose the peer.

```sh
rtk cargo test --locked --test batch --test runs_http
RUNS_TEST_DATABASE_URL=<empty disposable PostgreSQL URL> \
  rtk cargo test --locked --test runs_storage -- --ignored
TRANSFER_TEST_DATABASE_URL=<empty disposable Supabase/Vault URL> \
  rtk cargo test --locked --test runs_http -- --ignored
```

Apply `tests/support/vault.sql` as `supabase_admin` before the Vault test. Each
ignored suite needs a fresh container because migrations create cluster-level
roles. CI isolates the storage and Vault suites in matrix jobs. Local tests
cover three recipients, audited Vault reads, durable receipts, exact encrypted
balance arithmetic, partial failure recovery, races, RLS and amount-free storage.
Those integration tests simulate RPC/Auth replies and approvals.

On 2026-10-03, run `0b6bf3e1-5f65-47a2-a14e-c1877f33b96a` executed three
payments after one approval in a local browser harness. The actual run routes
verified a real disposable Supabase Auth session, wallet ownership and one
audited Vault key read. Each 2,913-byte v1 transaction finalized and received
its own durable receipt:

| Payment | Devnet transaction | Finalized slot |
|---|---|---|
| 1 | [2vMGTitk…3PLyHYS](https://explorer.solana.com/tx/2vMGTitkiE8RPf9XeHTtVyVf6XK9oXCSCU5DtgtqVENvAfqud6QUGSkZ78jpiLXLrTNgzCCZWEYvJbG7C3PLyHYS?cluster=devnet) | 507099198 |
| 2 | [4bXi9HSF…n8uXkW](https://explorer.solana.com/tx/4bXi9HSFkuXuzRcRpdS3VYwaE26MyKMbdcgxGGUfLwcQkkhmcofvwGBAQwivw68ns5uBiv8to1mEVMUqTzn8uXkW?cluster=devnet) | 507099212 |
| 3 | [23aXgPLL…YakiLJ](https://explorer.solana.com/tx/23aXgPLLqWQJTBk12ru71r9zXr19US72WHnuPVAMyGXjLu1PvsX9XWzyagyhCwG8F1eUaPeJKRkwTo1LgvYakiLJ?cluster=devnet) | 507099225 |

The harness decrypted every recipient credit and the total sender debit,
verified all nine proof contexts were closed, and checked ciphertext without
plaintext amount fields through the independent OnFinality RPC. The
[evidence record](spikes/2026-10-03-runs-devnet.json) contains public receipt
metadata only. Signing used the existing Turnkey root test adapter outside
the proof runtime. This verifies the batch HTTP contract and one-approval
execution in that harness. Production user-owned embedded signing remains #77;
the product approval UI remains #83. Hosted migration and deployment require
the target project and runtime credentials and were not performed by this check.
