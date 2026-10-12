# Backend APIs for web integration

Status: implemented in the current checkout, 2026-10-11. This reference covers
the backend work accepted for [#63](https://github.com/Dnreikronos/cadence/issues/63).
Deployment and frontend/backend sign-off are separate. Implementation and
verification are recorded in the [backend plan](../plans/2026-10-11-063-backend-implementation.md).
Frontend clients, screens and mocks are owned by the frontend team. The concrete
client changes are listed in [the integration handoff](WEB3_INTEGRATION_HANDOFF.md).

## Authentication and transactions

The service verifies the Supabase bearer token through `/auth/v1/user`; it does
not trust decoded JWT claims. Payroll creation/retry require company-admin
membership and wallet ownership. New account and owner-read routes require an
admin or recipient membership, with the recipient/company scope enforced for
private reads. Auditor reads/exports require the existing company grant.

First-use wallet association uses the existing exact signing message:

```text
Cadence wallet association
user:<canonical Supabase UUID>
wallet:<wallet address>
```

The final line has no trailing newline. Send its base58 signature as
`wallet_signature`. This message is separate from key derivation. All customer
transactions remain unsigned; the backend never signs or submits them.
Wrap uses v0, and payment, withdrawal, configure and apply use v1. Base64 wire
bytes contain zeroed signature slots; the wallet is the sole signer and fee
payer. Sign the unchanged message and retain the original signature for
confirmation/reconciliation. A timeout or an absent RPC receipt, even after
blockhash expiry, does not authorize replacement.

## Payroll recovery and consent

`POST /runs` retains the positional shape in [RUNS_API.md](RUNS_API.md) and adds:

```json
{
  "idempotency_key": "63000000-0000-4000-8000-000000000001",
  "allow_transparent": false
}
```

These fields accompany the existing wallet, sender, AES key, optional wallet
signature and payments. The UUID key is required and must be nonnil. A database
lock serializes creation across processes for the owner; the run and payments
commit together. Repeating a key returns the original committed run and its
still-prepared signing payloads without regenerating proofs. The original
request wins, including its amounts and consent. A changed wallet, sender or
ordered destinations returns `409 idempotency_conflict`. Amounts and amount
fingerprints are not persisted for request comparison. To change the intended
payments, use a new key after earlier overlapping attempts are resolved.

A new key cannot create another payment to a destination with an unresolved
prepared run payment for the same owner: `409 outstanding_payments`. Recovery
keeps original transactions and expiry; it does not refresh blockhashes or
increment attempts.

| Route | Result |
| --- | --- |
| `GET /runs` | Owner metadata pages; no signing payloads or amounts. |
| `GET /runs/:id` | Existing owner-scoped metadata. |
| `GET /runs/by-key/:key` | Recover by creation key, including prepared payloads. |
| `GET /runs/:id/prepared` | Recover prepared payloads by known run ID. |
| `POST /runs/:id/confirm` | Existing positional confirmation and item errors. |
| `POST /runs/:id/retry` | Existing evidence-based retry; admin and wallet ownership required. |

List pagination uses ascending UUIDs, `limit` 1–100 (default 20), and the last
returned run ID as `cursor`. Unknown outcomes remain prepared. The existing
retry flow may rebuild eligible terminal failures while unresolved positions
remain blocked; it never synthesizes failure from missing history. There is no
automatic cancellation or manual release endpoint.

Standalone `POST /transfer`, run creation and run retry accept
`allow_transparent`, default false. If the proof program is unavailable, omission
or false returns `409 transparent_consent_required` before a public transaction
is built or persisted. True permits fallback from the source's public wrapped
balance. Each prepared attempt still reports `transparent`. See [FALLBACK.md](FALLBACK.md).
All run responses, including errors and recovery, are `Cache-Control: no-store`.

## Account discovery and enrollment

Use `POST /accounts/discover` with `wallet`, optional `token_account` and optional
first-use `wallet_signature`. An explicit auxiliary account must already exist,
belong to that wallet and hold the wrapped mint under Token-2022. For a new
account, the service explicitly returns the canonical wrapped-mint ATA. A
missing noncanonical account is rejected. One immutable mapping is maintained
per user/wallet; another mapping returns `409 account_mapping_conflict`.

The response includes `wallet`, `token_account`, `mint`, `key_enrolled`,
`account_configured`, and `derivation_message` as base64. Decode the message
before signing. It is exactly `ViewingKey::signing_message(token_account)` from
the pinned SDK, including the account-specific binary bytes. The service also
returns it through `GET /keys/message?wallet=...&token_account=...`, after wallet
association and account authorization.

`POST /keys/enroll` takes:

```json
{
  "wallet": "<wallet address>",
  "token_account": "<validated token account>",
  "signature": "<base58 signature of the canonical derivation message>",
  "wallet_signature": "<optional first-use wallet association signature>"
}
```

The derivation signature is key-equivalent: never log, persist or reuse it as a
wallet-link signature. The backend verifies it, checks ownership/mint and any
existing on-chain confidential public key, and derives both ElGamal and AES keys.
It stores their material as encrypted Vault secrets through restricted accessors.
Ordinary tables contain no plaintext keys or amounts. Identical enrollment is
idempotent and returns `200 {"status":"enrolled"}`; an existing key is never
replaced. Database parameter logging must be disabled before transmitting key
material or roster amounts.

`GET /company/accounts` returns the admin's mapping or null. `GET /me/status`
returns wallet/account addresses when mapped, `wallet_created`, `key_enrolled`,
`account_configured`, `activated`, and numeric `pending_credit_counter`.
Compatibility fields `wallet_linked` and `pending_credits` are also returned:
`wallet_linked` equals `wallet_created`, and `pending_credits` is
`pending_credit_counter > 0`. They use the same verified mapping/finalized snapshot
and are both false when no mapping exists; no separate flags are stored.
`key_enrolled` requires the balance-key material needed by the new read APIs.
Configuration/status checks use finalized account state. A verified ready account
activates its linked pending person. Mapping readiness is refreshed after
confirmation or a finalized status/discovery check.

`GET /company/people/accounts` exposes paged `{person_id, token_account}` mappings;
`token_account` is null until readiness has been verified. The same mapping is
available to authorized Supabase readers through the RLS-protected
`public.people_accounts` view. Sender accounts are returned explicitly, and
existing non-ATA accounts remain supported.

## Configure and apply pending

`POST /accounts/configure` and `POST /accounts/apply-pending` take
`{wallet, wallet_signature?}` after discovery/enrollment. The backend loads the
canonical keys through a committed audit gate and constructs the public setup
proof or new decryptable balance. Caller-supplied temporary setup keys are not
used. Both return the standard prepare envelope, plus `token_account`:
`request_id`, base64 `transaction`, `transaction_version: 1`, `required_signers`,
`recent_blockhash`, and `last_valid_block_height`.

One prepared request per user/operation is retained. Repeating prepare recovers
the original bytes and expiry, including after a lost response; it does not
rebuild an uncertain operation. PostgreSQL locking and a unique partial index
enforce this across concurrent callers.

The corresponding `/confirm` endpoints take `{request_id, signature}` and return
`{request_id, signature, slot, status: "finalized"}`. Confirm persists the verified
submission before asking RPC, verifies the exact finalized message, and checks
the account snapshot at or after the receipt slot. The chain indexer also
recovers successful or failed account requests, including wallet-history
discovery when the confirmation request was lost.

Apply with no pending credits returns `409 nothing_to_apply`. A finalized apply
whose actual and expected credit counters disagree is recorded before returning
`409 credit_counter_mismatch`; confirming the same signature again returns the
stored receipt. Private balance reads and another apply fail closed on that
counter mismatch, rather than presenting the potentially stale AES balance as
the actual available balance. A verified failed transaction returns
`409 transaction_failed` and can be prepared again. Missing history leaves the
original operation unresolved.

## Private reads and roster amounts

| Route | Authorization and response |
| --- | --- |
| `GET /me/balance` | Recipient; `{available, pending, as_of_slot}`. |
| `GET /company/balance` | Admin; same shape for the mapped source account. |
| `GET /me/payments` | Recipient; finalized incoming payment page. |
| `GET /company/payments` | Admin; finalized company payment page. |
| `GET /company/people/amounts` | Admin; `{person_id, token_account, amount}` page. |
| `PUT /company/people/:person/amount` | Admin; `{amount}` writes encrypted roster amount. |
| `POST /company/people/:person/amount` | Equivalent write for POST-only clients. |

Amounts are decimal base-unit strings in authorized success responses. Balance
reads use one finalized RPC account snapshot, its slot, and the enrolled AES and
ElGamal material. The pending amount is decrypted from the low/high ciphertexts;
it is not inferred from the number of credits. Missing/inconsistent state fails
closed.

Payment reads return the existing payment item shape: `payment_id`, nullable
`run_id`, `{id, name}` counterparty with nullable ID, `amount`, `status:
"confirmed"`, `transparent`, `paid_at` and `signature`. They include finalized
run and standalone transfers, including public fallback. Unresolved progress is
read through run metadata; unprepared amounts are not invented. Owner pages use
ascending UUIDs, `limit` 1–100/default 20, and the last returned ID as cursor.
Unknown/duplicate query fields and malformed UUIDs are rejected.

Roster amounts are encrypted in Vault with company/person context binding.
Unset amounts and unavailable recipient mappings are null. Removed or
cross-company people cannot be written. Each private balance/page call commits
one audit row before decryption, including empty pages. A read permit cannot be
used inside the transaction that issued it or after role/grant revocation.
CPU decryption holds its concurrency permit until the worker exits, including
after an HTTP timeout. Every private read/write success and error is no-store.

## CSV exports

`GET /company/export.csv`, `GET /me/export.csv` and
`GET /audit/:company/export.csv` reuse the matching company, recipient or auditor
scope. Each export captures a bounded set of finalized receipts and commits one
audit row before decryption. Up to 10,000 payments are exported; a larger set
returns `409 export_too_large` before reading its keys. There is no silent
truncation. Filters remain a future proposal; query parameters are rejected.

Columns are `date,counterparty,amount,status,signature`. Amounts use integer math
and exactly six USDC decimals. Output uses RFC 4180 quoting and CRLF. Every text
cell is neutralized before quoting when it starts with a formula marker,
including after leading whitespace, or a tab/line break. Responses use
`text/csv; charset=utf-8`, attachment disposition, nosniff and no-store.

CORS retains the configured origin policy, allows GET/POST/PUT, exposes
`Retry-After`, and does not enable cookies. New errors are fixed codes only:
`invalid_idempotency_key`, `idempotency_conflict`, `transparent_consent_required`,
`account_mapping_conflict`, `account_not_registered`, `account_request_not_found`,
`account_already_configured`, `account_already_confirmed`, `key_not_enrolled`,
`nothing_to_apply`, `credit_counter_mismatch`, `person_not_found`,
`balance_unavailable`, and `export_too_large`. Error bodies contain no amount,
derivation signature, key or raw RPC/database detail. Reveal-risk 409 retains
its existing amount-free risk metadata, as documented in [UNWRAP_API.md](UNWRAP_API.md).

## Deployment

Apply all existing migrations in order, then the five
`20261011000000`–`20261011000004` migrations. They add run recovery/authorization,
account mappings and encrypted AES access, account receipts, owner/roster read
gates, auditor export gates and account-indexer permissions. The existing proof
transfer/key/indexer database URLs and dedicated roles are reused; auditor
exports use the existing audit-service URL. No additional signing credentials
or customer wallet private keys are required by this backend implementation.
Existing ElGamal-only enrollments need the authenticated canonical enrollment
step to add the encrypted AES material for balance reads. Migrations have been
tested in disposable local Supabase instances, not applied to hosted data.

## Temporary RPC read failures

Allowlisted chain reads make at most three attempts for connection/request/body
transport failures, HTTP 408/429/500/502/503/504, and validated node-unhealthy or
minimum-context-slot RPC errors. Their 250ms/500ms waits, response reads and all
attempts share the original `PROOF_RPC_TIMEOUT_MS` budget. Numeric Retry-After
can extend the wait only within that remaining budget; a nonnumeric header
disables retry. Lower-level automatic retries are disabled.

Parameters, finalized commitment, minimum context slot and supported transaction
version are retained across attempts. Null history, malformed responses, invalid
account data, other RPC errors and wrong-cluster results retain their existing
failure/uncertainty handling. The service never retries transaction submission
or another write. Exhausted reads still return the fixed `503 rpc_unavailable`;
they cannot release an unresolved payment or generate replacement signing bytes.

Diagnostics include only the allowlisted RPC method, fixed category, attempt,
HTTP status, recognized RPC error code and retry decision. Provider URLs,
credentials, request parameters, error messages/data, keys and amounts are
excluded. See the [RPC resilience follow-up](../plans/2026-10-12-063-rpc-resilience.md).

For live integration, configure a provider with capacity for the API and chain
indexer together. The shared public devnet endpoint can still return 429 beyond
the bounded retry budget; retries do not replace provider capacity. Alchemy's
[devnet HTTP endpoint](https://www.alchemy.com/rpc/solana-devnet) and
[subscription endpoint](https://www.alchemy.com/docs/reference/solana-subscription-api-endpoints)
use separate hosts:

```dotenv
PROOF_RPC_URL=https://solana-devnet.g.alchemy.com/v2/YOUR_API_KEY
PROOF_RPC_WS_URL=wss://solana-devnet.streaming.alchemy.com/v2/YOUR_API_KEY
```

Keep both in the ignored `services/proof/.env.local` for local backend work, or
inject them through the deployed service's environment. The Rust service reads
process environment variables; it does not load dotenv files automatically.
From the repository root, load the local file before starting the service:

```bash
set -a
source services/proof/.env.local
set +a
```

Retain the existing database, Supabase, build and other runtime variables. Set
both provider URLs explicitly so HTTP reads and WebSocket indexing use the same
devnet provider. Provider credentials are backend configuration and do not
belong in frontend `NEXT_PUBLIC_*` variables.
