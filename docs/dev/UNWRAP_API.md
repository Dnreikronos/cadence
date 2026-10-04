# Unwrap API (#56)

The authenticated recipient converts confidential available wrapped-USDC balance
to ordinary SPL USDC in their wallet's associated token account. The same request
checks received payments for reveal risk before returning a signable transaction.
The wallet signs and submits; the proof service never receives a signing key.

Apply `supabase/migrations/20261004000000_unwrap_requests.sql` after the transfer
and runs migrations. Reuse the transfer service's Supabase Auth settings and
separate `PROOF_TRANSFER_DATABASE_URL` / `PROOF_KEY_DATABASE_URL` credentials.
The receipt role remains `cadence_transfer_service`; Vault remains isolated behind
`cadence_key_service`. Unconfigured routes return `503 unwrap_unavailable`.

## Prepare

Send `Authorization: Bearer <Supabase access token>` to `POST /unwrap`:

```json
{
  "wallet": "<recipient wallet public key>",
  "amount": "4200000",
  "aes_key": "<base64 16-byte balance key>",
  "acknowledge_reveal_risk": false,
  "wallet_signature": "<first-use wallet association signature>"
}
```

Amounts are integer base-unit strings in 1..=2^48−1, with six USDC decimals.
The AES key and first-use association signature follow [the transfer contract](TRANSFER_API.md).
The wallet must own its canonical wrapped-USDC ATA, have its ElGamal key enrolled
in Vault, and have pending credits applied. `wallet_signature` can be omitted
after association. Never send the confidential derivation signature in its place.

Risk compares this amount with confirmed incoming standalone transfers and
finalized run payments for that token account. Their recipient ciphertexts are
decrypted using an audited Vault key read; plaintext amounts remain transient.
Failed, unsigned and unresolved payments do not count. History/key failures block
the request. History exceeding 1000 payments also fails closed, rather than
silently dropping older payments.

`PROOF_REVEAL_RISK_TOLERANCE_BPS` accepts 0..=10000 and defaults to 100 (1%).
Near matches include either boundary, relative to the received amount; zero means
exact-only checks. Integer arithmetic avoids floating-point/overflow errors.
An exact match takes precedence over near matches. The flag has this shape:

```json
{
  "level": "exact",
  "matches": [{ "payment_id": "<uuid>", "paid_at": "2026-10-04T12:00:00Z" }]
}
```

Matches contain IDs and dates only. The backend returns no warning prose.
`none` has no matches. Incoming receipts have stable UUIDs, and new confirmations
record their timestamp. Historical receipts use their original preparation time
because the previous schema did not retain a confirmation timestamp.

A risky request without acknowledgement returns HTTP 409:

```json
{
  "error": "reveal_risk_not_acknowledged",
  "reveal_risk": {
    "level": "exact",
    "matches": [{ "payment_id": "<uuid>", "paid_at": "2026-10-04T12:00:00Z" }]
  }
}
```

No withdrawal proofs, transaction
or unsigned receipt are built in this case. Render the warning, obtain the
recipient's acknowledgement, then prepare again with the boolean set to true.
Acknowledgement does not guarantee anonymity; the public withdrawal can still
reveal its amount. The frontend's mock-backed request schema must supply the
AES key and association signature before switching this flow to the live service.

A successful response contains the standard `request_id`, base64 `transaction`,
`transaction_version: 1`, `required_signers`, `recent_blockhash` and
`last_valid_block_height`, plus `source`, `destination`, the ordinary USDC `mint`
and `reveal_risk`. The only signer is the recipient wallet. Its normal-USDC ATA
is created idempotently, the confidential amount is withdrawn, then token-wrap
burns it and releases the same amount from escrow, all in one transaction below
4096 bytes. Pending credits are not automatically applied. Prepare again after
blockhash expiry or an account balance change; never modify the returned message.

`POST /unwrap/check` accepts `wallet`, `amount`, and optional `wallet_signature`,
with the same authentication. It returns HTTP 200 with
`{requires_acknowledgement, reveal_risk}` and builds no transaction. No AES key
is required. The prepare route always repeats the check against fresh history.

## Confirm

`POST /unwrap/confirm` accepts the usual `{request_id, signature}` and the same
user's token. It verifies successful finalized execution, the exact prepared
message, and the sole wallet signature through the shared confirmation verifier.
It returns `{request_id, signature, slot, status: "finalized"}`. Other users get
404. Duplicate confirmations are idempotent; concurrent confirmations cannot
overwrite an existing signature or slot. Failed/nonfinalized transactions are
not recorded. The database role cannot delete receipts or edit their transaction.

## Errors and limits

Fixed error codes include `invalid_request`, `invalid_wallet`, `invalid_amount`,
`invalid_balance_key`, `invalid_request_id`, `invalid_signature`,
`authentication_required`, `wallet_access_denied`, `unwrap_not_found`,
`unwrap_requires_devnet`, `reveal_risk_not_acknowledged`,
`withdrawal_balance_unavailable`, `confidential_key_mismatch`,
`proof_generation_failed`, `transaction_not_finalized`, `transaction_failed`,
`transaction_mismatch`, `unwrap_already_confirmed`, `unwrap_storage_unavailable`,
`key_storage_unavailable`, `reveal_history_unavailable`, and `rpc_unavailable`.
Errors never interpolate amounts, AES keys, signatures or upstream payloads.

Unwrap/check/confirm share 8 KiB bodies, 120 requests/minute globally, 30 per
direct peer, eight concurrent HTTP requests, and a 30-second timeout per process.
Prepare/check additionally allow ten requests/minute per wallet. The four CPU
slots are shared with transfer/runs, and remain held until CPU work finishes
after a timed-out HTTP request. Limits return `429 unwrap_rate_limited` with
`Retry-After: 60`; timeouts return `503 unwrap_timeout`.

## Verification

`unwrap_builder` verifies real equality/range proofs, proof offsets, the AES
balance update, token-wrap account ordering, signer count, wire size and invalid
inputs. `unwrap_http` covers audited history from transfers and runs, the warning
gate, safe amounts, account attribution, exact message confirmation, database
permissions, immutable receipts and failures of the audit/history dependencies.
The ignored database test requires a fresh disposable Supabase instance with
`tests/support/vault.sql` applied; CI runs it in its own Vault matrix entry.

```sh
cargo test --locked --lib solana::reveal_risk
cargo test --locked --test unwrap_builder --test unwrap_http
TRANSFER_TEST_DATABASE_URL=postgres://postgres:<test-password>@localhost:55456/keys_test \
  cargo test --locked --test unwrap_http -- --ignored
```

The recorded wallet spike found Phantom advertising legacy/v0 signing. This route
returns v1, so frontend provider integration and a Phantom UI acceptance check
remain separate from backend correctness and standard-USDC balance verification.

On 2026-10-04, the actual HTTP routes prepared and confirmed a live devnet
withdrawal. An incoming confidential transfer was finalized, its pending credit
applied, and the exact withdrawal returned the structured 409 without a
transaction. After acknowledgement, an external disposable SDK wallet signed
the 1,918-byte v1 transaction. It finalized at slot 507511594, credited 42 base
units to the ordinary USDC ATA, and debited the confidential available balance
to zero. An independent OnFinality RPC confirmed successful execution:
[devnet withdrawal](https://explorer.solana.com/tx/4ArfEXW7fRcJ3Fv5EZcHWXC96PwMorue7Sm6ouzyo4HwNdQwvQvdvn8mcHdhBqtXY4A2Ugo7cvGQHWXtDwaRzp4s?cluster=devnet).
The [public evidence](spikes/2026-10-04-unwrap-devnet.json) records the scope:
local Auth fixture, real disposable Supabase Vault and real devnet execution.
This did not exercise a Phantom screen or production embedded-wallet onboarding.
