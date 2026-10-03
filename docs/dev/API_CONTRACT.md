# API contract for the web app

Issue [#63](https://github.com/Dnreikronos/cadence/issues/63). This is what the
web app builds and mocks against (#79), so the frontend and the proof service
agree on one shape before the remaining routes exist.

**Status: draft for review.** Every route is marked:

- ✅ **Implemented.** Described from [`WRAP_API.md`](WRAP_API.md),
  [`TRANSFER_API.md`](TRANSFER_API.md) and `services/proof/src`. Changing these is a
  breaking change.
- 🟡 **Proposed.** The route does not exist yet. The shape below is the
  frontend's request, derived from the open issue that will build it. It is not
  settled until the backend owner signs off, and the questions that need an
  answer are collected in [Open questions](#open-questions).

Nothing here changes a confidential-transfer rule: the browser never holds a
viewing key, the service never holds a signing key (ADR B9), and no
off-chain store holds a readable amount (ADR B12).

## Conventions

| Topic | Rule |
|---|---|
| Base URL | Read by the web app from an env var (proposed name `NEXT_PUBLIC_PROOF_API_URL`). The service is a separate origin, so CORS applies (`PROOF_CORS_ORIGINS`). |
| Format | JSON in and out, `Content-Type: application/json`. Bodies are limited to 8 KiB and unknown fields are rejected. |
| Amounts | **Integer base units as a decimal string**, six decimals: `"1000000"` is 1 USDC. Never a JSON number, never `"1.5"`. Valid range is `1` to `2^48 - 1` (`281474976710655`). The web app converts at the edge with exact integer math and never uses floats for money. |
| Identifiers | `request_id` is a 64-character hash. Wallet and account fields are base58 public keys. Signatures are base58 transaction signatures. |
| Time | RFC 3339 UTC. |
| Cluster | Devnet only today. A request on another cluster fails with `transfer_requires_devnet`. |
| Rate limits | Fixed 60 s windows. A limited call returns `429` and `Retry-After: 60`. The client waits that long and does not auto-retry in a loop. |

### Authentication ✅ for `/transfer`, 🟡 for everything else

Send the Supabase session's access token:

```http
Authorization: Bearer <Supabase access token>
```

The service verifies it on every call by asking Supabase Auth
(`GET {PROOF_SUPABASE_URL}/auth/v1/user` with the project's public API key). It
accepts a token of at most 8,192 bytes and uses the returned user UUID, in
canonical lowercase form, as the caller's identity. It never trusts a claim in
the token body.

- A missing, malformed or rejected token is `401 authentication_required`.
- If Supabase Auth cannot be reached, the call fails with
  `503 auth_unavailable`. The client treats that as retryable and does **not** sign
  the user out.
- The web app refreshes the session in the browser as usual and sends the
  current token. It does not forward the refresh token.

**Wallet association (✅).** The first `/transfer` for a wallet carries
`wallet_signature`, a signature over exactly these UTF-8 bytes with no trailing
newline:

```text
Cadence wallet association
user:<verified Supabase user UUID, lowercase>
wallet:<company_wallet>
```

Later calls omit it. A wallet cannot be reassigned, and another user cannot claim
an existing link (`wallet_access_denied`). This is a different message from the
key-derivation message; the two are never interchangeable.

**Roles (🟡).** Routes under `/me`, `/company` and `/audit` authorize from the
caller's `memberships` row (admin, recipient or auditor, one company each). The
web app's route guard only chooses which page to show. The service enforces the
role itself on every call, because row-level security is the authorization
boundary (ADR B13). A caller reaching a route outside their role gets
`403 forbidden_role`; a resource in another company is `404`, never `403`, so a
response never confirms that it exists.

`/wrap` and `/wrap/confirm` (✅) currently accept calls without a user token. The
proposal is to require the same bearer token as `/transfer` before the web app
ships them (see [Open questions](#open-questions)).

## Errors

Every error is a fixed JSON object:

```json
{ "error": "<stable_code>" }
```

- The code is the contract. The message shown to people is written by the web app
  per code, so copy can change without a backend release.
- **No error ever contains an amount, a key, a token, a signature or any value from
  the request.** Rejected JSON cannot echo what was sent.
- Statuses are fixed per code: `400` malformed, `401` unauthenticated, `403` not
  allowed, `404` unknown or not yours, `409` a rule or chain state conflicts, `429`
  rate limited, `503` a dependency is down, `500` `internal_error`.
- The client only branches on the code and treats any unknown code as its status
  class, so adding codes later is not breaking.

### Codes in use ✅

| Status | Codes |
|---|---|
| 400 | `invalid_request`, `invalid_account`, `invalid_amount`, `invalid_balance_key`, `invalid_request_id`, `invalid_signature` |
| 401 | `authentication_required` |
| 403 | `wallet_access_denied` |
| 404 | `transfer_not_found`, `wrap_not_found` |
| 409 | `wallet_link_required`, `transfer_requires_devnet`, `sender_account_missing`, `recipient_account_missing`, `invalid_confidential_state`, `proof_generation_failed`, `transaction_not_finalized`, `transaction_failed`, `transaction_mismatch`, `transfer_already_confirmed`, `confidential_setup_required` |
| 429 | `transfer_rate_limited`, `wrap_rate_limited` (both with `Retry-After: 60`) |
| 503 | `transfer_unavailable`, `auth_unavailable`, `key_storage_unavailable`, `transfer_storage_unavailable`, `wrap_storage_unavailable`, `rpc_unavailable`, `transfer_timeout` |
| 500 | `internal_error` |

### Codes this contract adds 🟡

`forbidden_role`, `reveal_risk_not_acknowledged`, `run_not_found`,
`payment_not_found`, `recipient_not_activated`, `person_not_found`,
`key_already_enrolled`, `credit_counter_mismatch`.

## Prepare, sign, confirm

Every action that moves funds uses the same three steps. The service builds an
unsigned transaction, the user's wallet signs and submits it, and the service
verifies what landed. **The service never signs or submits anything.**

```mermaid
sequenceDiagram
  participant W as Web app
  participant S as Proof service
  participant T as Turnkey wallet
  participant C as Solana RPC
  W->>S: POST /<action> (JWT, params)
  S-->>W: request_id, unsigned transaction, signers, blockhash
  W->>T: sign the exact bytes
  T-->>W: signed transaction
  W->>C: send the signed transaction
  W->>S: POST /<action>/confirm (request_id, signature)
  S->>C: read the finalized transaction
  S-->>W: receipt (signature, slot, finalized)
```

### Prepare response ✅

All prepare routes return the same core fields, plus route-specific ones:

```json
{
  "request_id": "<64-character hash>",
  "transaction": "<base64 unsigned wire transaction>",
  "transaction_version": 1,
  "required_signers": ["<base58 public key>"],
  "recent_blockhash": "<blockhash>",
  "last_valid_block_height": 123
}
```

- `transaction` is the exact wire bytes. The web app base64-decodes it, hands the
  bytes to the signer and signs **unchanged**. It never edits the message,
  replaces the blockhash or adds instructions: confirmation is bound to that
  message, and a changed one fails with `transaction_mismatch`.
- `transaction_version` is `0` for `/wrap` and `1` for `/transfer`. The signer must
  support the version it is given. Extension wallets do not sign version 1 yet, so
  every user signs through a Turnkey embedded wallet (#77). Never fall back to
  signing the bytes as a message.
- `required_signers` lists every key that must sign, in the order the service
  expects. The web app signs only for keys it controls and **fails loudly if it is
  asked to sign for a key that is not the user's wallet** (see
  [Open questions](#open-questions) on a service fee payer, #66).
- Returning bytes does not move funds. Signing is the authorization.

### Confirm ✅

```json
{ "request_id": "<from prepare>", "signature": "<submitted transaction signature>" }
```

Success returns the receipt, and a repeat returns the same receipt:

```json
{ "request_id": "<id>", "signature": "<signature>", "slot": 123, "status": "finalized" }
```

- The service reads the transaction at finalized commitment with
  `maxSupportedTransactionVersion: 1`, and records a receipt only if execution
  succeeded, the message matches what it prepared, and the wallet's signature
  verifies.
- `409 transaction_not_finalized` means "not yet". The web app retries `/confirm`
  with a short backoff (about 2 s growing to 10 s) for up to 60 s, showing
  "Waiting for the network", and then offers a manual retry. It does not prepare a
  second transaction while one may still land.
- `409 transaction_failed` and `409 transaction_mismatch` are final for that
  `request_id`. The user starts again from prepare.
- Another user's `request_id` is `404`.

### Expiry and retries

- A prepared transaction expires with its blockhash (`last_valid_block_height`).
  After expiry the web app prepares again; it never reuses the old bytes.
- A transaction may have landed even if the browser lost the response.
  **Before preparing a replacement for a payment that was already submitted,**
  reconcile: confirm the earlier `request_id` first. Preparing a fresh deposit
  or payment on top of one that landed pays twice.
- Identical preparations share a `request_id` and cannot erase an earlier
  confirmation.

## Routes

### Health ✅

`GET /health` needs no authentication. It returns
`{ "status": "ok", "build_sha": "<sha>", "rpc_reachable": true }` with `200`, or
`status: "unavailable"` and `rpc_reachable: false` with an error status when the
Solana RPC cannot be reached. The web app uses it only for a service-status banner.

### Wrap: public USDC to private ✅

`POST /wrap`, then `POST /wrap/confirm`. Used by the Deposit screen (#82).

```json
{ "company_wallet": "<wallet public key>", "amount": "1000000" }
```

Add `setup` when the destination account is not configured yet, with the two
public activation artifacts (`pubkey_validity_proof`, `decryptable_zero_balance`,
both base64). If the account is already configured, omit it.

The prepare response adds `destination` (the Token-2022 account), `mint` and
`deposit_state: "pending_after_confirmation"`. The wrapped amount lands in the
**pending** balance, and is only spendable after `POST /accounts/apply-pending`.
The web app must not call it "available" before that step. A deposit is public by
design.

Errors that matter to the UI: `confidential_setup_required` (send the activation
flow), `invalid_amount`, and the `409` codes for insufficient USDC or credits that
cannot be accepted.

### Transfer: one confidential payment ✅

`POST /transfer`, then `POST /transfer/confirm`.

```json
{
  "company_wallet": "<wallet public key>",
  "sender": "<source Token-2022 account>",
  "recipient": "<destination Token-2022 account>",
  "amount": "4200000000",
  "aes_key": "<base64 16-byte AES balance key>",
  "wallet_signature": "<base58, first request only>"
}
```

`sender` and `recipient` are token accounts, not wallets. The response is the
standard prepare response with `transaction_version: 1`, plus `sender`,
`destination` and `mint`. Only the company wallet signs.

> The `aes_key` field is how the service learns the sender's balance key today.
> It must never be logged, stored by the web app or sent to analytics. Whether
> the service should read it from Vault instead is in
> [Open questions](#open-questions).

Payments that fall back to an ordinary transfer (#60) are flagged `transparent`
in the read routes below, so the UI can show the "Transparent" badge.

### Payroll run: one approval, many recipients 🟡

For the headline flow (#55, #83). One confirmation by the admin, then one signature
per recipient.

`POST /runs`

```json
{
  "company_wallet": "<wallet public key>",
  "payments": [
    { "person_id": "<uuid>", "amount": "4200000000" }
  ],
  "idempotency_key": "<client uuid>"
}
```

The same `idempotency_key` returns the same run, so a double click cannot create
two. The response:

```json
{
  "run_id": "<uuid>",
  "payments": [
    {
      "payment_id": "<uuid>",
      "person_id": "<uuid>",
      "request_id": "<64-character hash>",
      "transaction": "<base64 unsigned wire transaction>",
      "transaction_version": 1,
      "required_signers": ["<company wallet>"],
      "recent_blockhash": "<blockhash>",
      "last_valid_block_height": 123
    }
  ]
}
```

`payments` is **in signing order**. The web app signs them one after another in a
single silent session, sends each, and confirms each:

- `POST /runs/:run_id/payments/:payment_id/confirm` takes
  `{ "signature": "<signature>" }` and returns the receipt for that payment.
- `GET /runs/:run_id` returns the run and **per-payment status without amounts**:

```json
{
  "run_id": "<uuid>",
  "created_at": "2026-10-03T19:00:00Z",
  "payments": [
    {
      "payment_id": "<uuid>",
      "person_id": "<uuid>",
      "status": "pending | signed | confirmed | failed | expired",
      "transparent": false,
      "failure": null,
      "signature": null
    }
  ]
}
```

`failure` is a stable code when `status` is `failed`, never a message with values.
One failed payment never blocks the rest. The web app can retry a single payment
through `POST /runs/:run_id/payments/:payment_id/retry`, which prepares a fresh
transaction for that payment only. People who are not activated are rejected with
`409 recipient_not_activated` and are excluded in the UI before the call.

Live status in the UI comes from Supabase Realtime on the payments table, which
holds no amounts, so `GET /runs/:id` is the fallback when Realtime is down.

### Unwrap: private USDC to public, with the reveal-risk flag 🟡

`POST /unwrap` then `POST /unwrap/confirm` (#56, #87). Prepare returns the usual
fields for a withdrawal from the confidential balance followed by the unwrap.

```json
{
  "wallet": "<recipient wallet public key>",
  "amount": "4200000000",
  "acknowledge_reveal_risk": false
}
```

The response carries a **structured flag**, not a rendered message:

```json
{
  "request_id": "<id>",
  "transaction": "<base64>",
  "transaction_version": 1,
  "required_signers": ["<wallet>"],
  "recent_blockhash": "<blockhash>",
  "last_valid_block_height": 123,
  "reveal_risk": {
    "level": "none | near | exact",
    "matches": [{ "payment_id": "<uuid>", "paid_at": "2026-10-03T19:00:00Z" }]
  }
}
```

- `level: "exact"` means the withdrawal equals an amount the person received, so an
  observer can link the two on-chain. `"near"` means within the service's
  configured tolerance. `"none"` has an empty `matches`.
- `matches` holds payment ids and dates only. **It never holds an amount.**
- When `level` is not `none` and `acknowledge_reveal_risk` is not `true`, the
  service returns `409 reveal_risk_not_acknowledged` and builds no transaction. The
  web app shows the warning, and sends the request again with the flag set only
  after the person confirms.
- The web app renders the warning text itself from `level`. It never shows
  backend-written prose.

### Accounts: configure and apply pending 🟡

For recipient activation (#67, #68, #80).

- `POST /accounts/configure` and `/accounts/configure/confirm` create the
  recipient's confidential token account and configure it, using the public
  pubkey-validity proof and the zero-balance ciphertext. Returns the usual prepare
  response.
- `POST /accounts/apply-pending` and `/accounts/apply-pending/confirm` move
  pending credits into the available balance. The service compares the expected
  and actual credit counter afterwards; a mismatch is `409 credit_counter_mismatch`
  and the web app prompts the person to retry rather than showing a wrong balance.

Both take `{ "wallet": "<public key>" }` and no amount.

### Key enrollment 🟡

`POST /keys/enroll` stores the encrypted viewing key material for the caller's
wallet (#50). The request carries the **signature** of the canonical
key-derivation message, which the web app obtains from the wallet's
`signMessage`. It never carries a key. A second call returns
`409 key_already_enrolled`. Never reuse the wallet-association signature here.

### Reading data 🟡

The service decrypts server-side (ADR B17) and answers only for the caller's own
data or their own company. **Each of these calls writes one row to the decryption
audit log (#49).** The web app therefore does not poll them in the background; it
reads on page load and on an explicit refresh.

All collection routes are paged: `?limit=50&cursor=<opaque>`, newest first, and
return `{ "items": [...], "next_cursor": "<opaque> | null" }`.

| Route | Who | Returns |
|---|---|---|
| `GET /me/balance` | recipient | `{ "available": "<base units>", "pending": "<base units>", "as_of_slot": 123 }` from the AES balance (ADR B3) |
| `GET /me/payments` | recipient | their payments |
| `GET /company/payments` | company admin | the company's payments |
| `GET /company/people/amounts` | company admin | the roster amounts (#64) |
| `PUT /company/people/:person_id/amount` | company admin | set one amount, `{ "amount": "<base units>" }`, stored encrypted |
| `GET /audit/:company_id/payments` | auditor with a grant on that company | decrypted amounts for that company |

A payment item:

```json
{
  "payment_id": "<uuid>",
  "run_id": "<uuid> | null",
  "counterparty": { "id": "<uuid>", "name": "Solaris" },
  "amount": "4200000000",
  "status": "pending | confirmed | failed",
  "transparent": false,
  "paid_at": "2026-10-03T19:00:00Z",
  "signature": "<signature> | null"
}
```

Amounts are strings of base units in these success responses, because the caller
is authorized to read them. They stay out of errors, logs, analytics and any
cache the browser persists. The web app keeps them in memory only.

An auditor with a grant on company A who asks for company B gets `404`.

### CSV export 🟡

`GET /company/export.csv`, `GET /me/export.csv` and `GET /audit/:company_id/export.csv`
(#70). Columns are `date,counterparty,amount,status,signature`, and the amount is
a decimal USDC string. Each export writes one audit row.

Because the browser must send the bearer header, the web app fetches the file with
`fetch`, builds a `Blob` and triggers the download. A plain link cannot
authenticate.

### Invites 🟡

`POST /company/people/:person_id/invite` creates or resends an invite and returns
`{ "status": "sent", "expires_at": "..." }`. It is a service route because it needs
the service role and cannot run from the browser (#69, #81). The email never
contains an amount.

## What the web app guarantees in return

- It sends amounts only as base-unit strings, and only to the routes above.
- It never sends a wallet private key, ElGamal secret, AES key outside `/transfer`,
  or a key-derivation signature anywhere but `/keys/enroll`.
- It does not log request or response bodies, and keeps these fields out of Sentry,
  analytics and proxy logs.
- It treats `transaction` as opaque bytes and signs them unchanged.
- It handles `429` by waiting `Retry-After`, and `503` as retryable.

## Mocks (#79)

The typed client is written against this document and every route above has a mock
handler, including each failure that changes the UI:

- Prepare then confirm for wrap, transfer, run payments and unwrap, with
  `transaction_not_finalized` on the first one or two confirm calls.
- A run with a mix of confirmed, failed and expired payments.
- `reveal_risk` at `none`, `near` and `exact`, and
  `reveal_risk_not_acknowledged` when the flag is missing.
- `confidential_setup_required`, `recipient_not_activated`, `transaction_failed`,
  `transaction_mismatch`, `credit_counter_mismatch`, `forbidden_role`.
- `401`, `429` with `Retry-After`, and `503` with `auth_unavailable`.
- Slow responses, so the progress states are exercised.

A handler returns an error body with **only** `{ "error": code }`, so a mock cannot
teach a screen to depend on a field the real service will not send.

## Open questions

These need an answer from the backend owner before the 🟡 routes are built.

1. **Fee payer (#66).** If Cadence co-signs as fee payer, `required_signers` has
   two keys and the transaction arrives partially signed. Which key signs first,
   and how does the web app tell "sign for me" from "already signed by Cadence"?
   Until this is decided, the client signs only for the user's wallet.
2. **Who submits.** This draft has the browser send the signed transaction to RPC,
   then confirm. Is that right, or should `/confirm` accept the signed transaction
   and submit it? The first keeps the service out of the signing path (ADR B9).
3. **`aes_key` on `/transfer`.** Sending the balance key in each request puts a
   long-lived secret in a browser request. Can the service read it from Vault for
   an authenticated, enrolled user instead?
4. **Runs and blockhash expiry.** Signing N transactions in sequence takes time.
   Does `POST /runs` return one blockhash per payment, and how long does a run's
   signing window stay valid for a large roster?
5. **Auth on `/wrap`.** Require the bearer token and the wallet association, like
   `/transfer`?
6. **Idempotency.** Is `idempotency_key` on `POST /runs` acceptable, and should
   the other prepare routes take it too?
7. **Amount format in reads.** Base-unit strings everywhere, including CSV, or
   decimal strings in CSV only?
8. **Pagination and limits** for `/company/payments` on a large roster.
9. **Transparent fallback (#60).** Is a boolean `transparent` per payment enough, or
   does the UI also need a global "confidentiality unavailable" signal before the
   admin approves a run?
10. **Reveal-risk tolerance.** Is it a service constant, or something the response
    should echo so the warning can say how close is "near"?

## Revisions

- 2026-10-03: first draft, written from the implemented wrap and transfer routes
  and the open backend issues. Awaiting review.
