# Transfer API (#54)

The proof service prepares one unsigned v1 confidential transfer. The user's
wallet signs and submits it; the service verifies finalized confirmation.
Amounts, AES balance keys, access tokens and wallet-link signatures are never
written to a receipt or returned in an error. The source and destination must
already be configured for confidential transfers, the sender's key must be
enrolled in Vault, and credits must already be applied to its available balance.

## Configuration

Apply `supabase/migrations/20261003000000_transfer_requests.sql` after the audit
and encrypted-key migrations. Provision LOGIN/passwords through deployment
secret management for `cadence_transfer_service` and `cadence_key_service`.
The runtime verifies the actual connected role and uses separate credentials.

| Setting | Purpose |
|---|---|
| `PROOF_SUPABASE_URL` | This project's Supabase HTTPS origin |
| `PROOF_SUPABASE_API_KEY` | Public API key for Supabase Auth |
| `PROOF_TRANSFER_DATABASE_URL` | Direct Postgres connection as `cadence_transfer_service` |
| `PROOF_KEY_DATABASE_URL` | Direct Postgres connection as `cadence_key_service` |
| `PROOF_RPC_URL` | Devnet RPC with transaction v1 support |

Transfer routes return `503 transfer_unavailable` when both database settings
are absent. Partial configuration fails startup. Auth-only Supabase settings
leave wrapping disabled unless `PROOF_WRAP_SERVICE_JWT` is also supplied.
Database TLS verifies certificates and hostnames against public roots and is
required by default. Only a loopback test URL explicitly using `sslmode=disable`
may use plaintext. Connection/query timeouts are five seconds; HTTP work is
limited to thirty seconds. Each key read uses its own autocommit connection.
TLS-terminating Postgres proxies must preserve the configured database role.

## POST /transfer

Send `Authorization: Bearer <Supabase access token>` and JSON:

```json
{
  "company_wallet": "<wallet public key>",
  "sender": "<source Token-2022 account>",
  "recipient": "<destination Token-2022 account>",
  "amount": "<integer base units>",
  "aes_key": "<base64 16-byte AES balance key>",
  "wallet_signature": "<base58 wallet association signature, first request only>"
}
```

One USDC is 1,000,000 base units. Accepted amounts are 1 through 2^48−1; do not
send a JSON number or decimal currency string. The mint is the deployed wrapped
USDC mint from `solana::token_wrap::Addresses::for_usdc()`.
Sender/recipient fields identify token accounts, not wallet addresses.

Supabase Auth verifies the token on every call. The first request for a wallet
needs its signature over these exact UTF-8 bytes, with no trailing newline:

```text
Cadence wallet association
user:<verified Supabase user UUID in canonical lowercase form>
wallet:<company_wallet>
```

`auth::wallet_link_message` generates this message. A browser can encode it
with `TextEncoder` and use its wallet's message-signing API. This differs from
the confidential key derivation message. Never reuse a derivation signature.
The wallet association cannot be reassigned through the API, and another user
cannot claim an existing link. Following requests omit `wallet_signature`.

Supply the AES balance key derived alongside the *enrolled* ElGamal key by the
canonical Solana SDK. Vault retains only the ElGamal secret; generating another
AES key breaks balance authentication. Serve the API over HTTPS and keep these
fields out of proxy/access logs, browser analytics and client error reports.
The browser never sends a wallet signing key to this service.

A successful response contains `request_id`, base64 `transaction`,
`transaction_version: 1`, `required_signers`, `sender`, `destination`, `mint`,
`recent_blockhash` and `last_valid_block_height`. Decode and sign the exact
wire bytes with a provider that supports v1. The transaction contains all three
proof-context creations/verifications, the confidential transfer and all three
closes. Its size is strictly below 4,096 bytes and only the company wallet signs.

After an expired blockhash or an account balance change, prepare again; never
edit the returned message or combine it with extra instructions. Preparation
uses fresh account snapshots and rent quotes, but a later chain change can still
make the transaction fail. Returning bytes does not submit a payment.

## POST /transfer/confirm

Use the same authenticated user and send:

```json
{"request_id": "<prepared request ID>", "signature": "<submitted transaction signature>"}
```

The RPC read uses base64, finalized commitment and
`maxSupportedTransactionVersion: 1`. A receipt is recorded only when metadata
reports success, the message exactly matches the prepared transaction, and the
signature verifies against the sole expected wallet. Response fields are
`request_id`, `signature`, `slot` and `status: "finalized"`.
Retry a not-yet-finalized transaction. Repeating a recorded confirmation returns
its receipt without another chain read, but still verifies the user's token.
Another user's request ID receives 404. Concurrent confirmations cannot replace
an existing signature or slot. The backend never signs or submits transactions.

## Errors and limits

Every response error is fixed JSON: `{"error":"<code>"}`. Rejected JSON,
including unknown fields and oversize bodies, cannot echo request values.

| Status | Examples |
|---|---|
| 400 | `invalid_request`, `invalid_account`, `invalid_amount`, `invalid_balance_key`, `invalid_request_id`, `invalid_signature` |
| 401 | `authentication_required` |
| 403 | `wallet_access_denied` |
| 404 | `transfer_not_found` |
| 409 | `wallet_link_required`, `transfer_requires_devnet`, `sender_account_missing`, `recipient_account_missing`, `invalid_confidential_state`, `proof_generation_failed`, `transaction_not_finalized`, `transaction_failed`, `transaction_mismatch`, `transfer_already_confirmed` |
| 429 | `transfer_rate_limited`, with `Retry-After: 60` |
| 503 | `transfer_unavailable`, `auth_unavailable`, `key_storage_unavailable`, `transfer_storage_unavailable`, `rpc_unavailable`, `transfer_timeout` |
| 500 | `internal_error` |

Bodies are limited to 8 KiB. Per process, the two transfer routes share 120
requests/minute globally, 30 per direct peer, eight concurrent HTTP requests,
and four concurrent proof workers. Preparation additionally allows ten
requests/minute per wallet. A worker keeps its permit after an HTTP timeout
until CPU work finishes. Forwarded headers do not choose the peer identity.

## Verification

`tests/transfer_auth.rs` checks Auth token validation and message binding.
`tests/transfer_http.rs` verifies real audited Vault access and durable receipts
with mocked Auth/RPC responses. Its ignored database test runs in the CI Vault
matrix, with a fresh Supabase Postgres instance and `tests/support/vault.sql`.
Set `TRANSFER_TEST_DATABASE_URL` to an empty disposable database to run it locally:

```sh
cargo test --locked --test transfer_http -- --ignored
```

This test signs the returned v1 transaction with an external test wallet and
decrypts its recipient ciphertext. Browser/provider signing and live devnet
confirmation are separate acceptance checks; local tests do not establish them.

On 2026-10-03, the actual HTTP routes verified a real Supabase Auth login,
a wallet association signature and an audited Vault key read. A browser drove
a local adapter using the existing Turnkey test credentials to sign and submit
the returned 2,913-byte v1 transaction on the deployed wrapped-USDC mint. The
[transfer](https://explorer.solana.com/tx/2UMi2A8NM8VQR1XA47aE716CoggjMTchyzJg6VthQxRAECCRtpUTw5q8pQdidz9pn4iLAJEmkXNER7MRRWhpRQyh?cluster=devnet) finalized
at slot 507081114. The recipient credit and sender debit were decrypted and
verified, all three proof-context accounts were closed, and the independent
OnFinality RPC exposed confidential ciphertext with no plaintext amount field.
The adapter kept its credential on the local signing server; the proof service
received no signing key. This proves the HTTP contract and Turnkey v1
compatibility. Production browser-side user-controlled embedded onboarding
remains [#77](https://github.com/Dnreikronos/cadence/issues/77).
