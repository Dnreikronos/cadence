# Backend/web3 integration handoff

The backend reference is [WEB3_API.md](WEB3_API.md). This handoff records the
client/mocks changes identified by the real browser gate for #63. Ownership of
those changes remains with the frontend team. Backend status compatibility is
implemented; nullable reads and positional payment protocols remain authoritative.

## Status and readiness

`GET /me/status` now includes the existing mock-client booleans as derived
compatibility fields. `wallet_linked` equals `wallet_created` from the verified
account mapping. `pending_credits` is `pending_credit_counter > 0` from the
finalized account snapshot. There are no additional persisted flags.

```json
{
  "wallet_created": true,
  "wallet_linked": true,
  "key_enrolled": true,
  "account_configured": true,
  "activated": true,
  "pending_credit_counter": 2,
  "pending_credits": true
}
```

Mapped responses also include `wallet` and `token_account`. Without a mapping,
both wallet booleans, key/configuration/activation booleans and `pending_credits`
are false, and the counter is zero. A linked wallet alone is not a ready account.
Use the verified status; never infer activation from a successful signing prompt.
Pending credit count is metadata, not an amount. Read actual units through
`/me/balance` or `/company/balance`.

## Nullable read values

| Response field | Meaning of null | Client behavior |
| --- | --- | --- |
| `/company/people/amounts.items[].amount` | No roster amount was set. | Accept `string \| null`; show “Not set”; omit unset values from totals. Keep unknown/loading/error separate from unset. |
| `/company/people/amounts.items[].token_account` and `/company/people/accounts.items[].token_account` | Recipient readiness has not been verified. | Keep the person visible and exclude their unmapped account from signing requests. |
| `/me/payments` and `/company/payments` `items[].counterparty.id` | The receipt has no linked person/company identity, including legacy or standalone receipts. | Accept `UUID \| null`; display the returned counterparty name and use `payment_id` for receipt identity. |
| `items[].run_id` | Standalone payment. | Accept null and retain the receipt. |

Amounts that exist remain decimal base-unit strings. A successful amount write
returns a non-null amount; read rows require a nullable schema. Do not convert
an unset amount into zero or assign a fabricated UUID to a counterparty. One
unset row must not cause the entire page to fail validation.

The browser gate observed a rejected status payload blocking recipient balance,
history and CSV. Adding status compatibility removes that schema boundary.
Recipient history will still reject legacy nullable IDs until its item schema is
updated. Roster reads currently reject unset amounts. These are separate client
changes; the existing browser validation record, summarized in the [published backend validation note](../plans/2026-10-12-063-backend-validation.md) records
the original outcomes and must not be relabeled as passing after a source edit.

## Account enrollment and signing

Discover through `POST /accounts/discover`, retaining the backend-returned
`token_account`; existing auxiliary accounts are supported. Establish ownership
with the separate wallet-association message when needed. Decode the returned
base64 `derivation_message` and sign those exact bytes. Enrollment sends
`{wallet, token_account, signature, wallet_signature?}`. The derivation signature
must never be logged or reused as the association signature.

Prepare configure/apply with `{wallet, wallet_signature?}`. Sign the returned
unchanged v1 message with the declared sole signer. Keep the request ID and actual
submission signature before calling the matching `/confirm` endpoint. Repeating
prepare recovers original bytes and expiry. Missing RPC history or a timeout
leaves the operation unresolved; it does not permit a replacement transaction.

## Payroll creation, recovery and consent

Use the positional contract in [RUNS_API.md](RUNS_API.md). `POST /runs` sends
`company_wallet`, explicit backend-returned `sender`, transient `aes_key`, ordered
`payments`, required nonnil UUID `idempotency_key`, and optional
`allow_transparent` (default false).

Recover a lost creation response with `GET /runs/by-key/:key`; recover signing
payloads with `GET /runs/:id/prepared`. The first committed request wins, including
its amounts; recovery does not refresh transactions. An unresolved payment to a
destination blocks creation with another key.

Confirm through `POST /runs/:id/confirm` using
`{payments:[{position, request_id, signature}]}`. Retry through
`POST /runs/:id/retry` with `aes_key`, optional `allow_transparent`, and
`{payments:[{position, amount, signature?}]}`. Each live prepared attempt requires
its retained original wallet transaction `signature`, alongside `position` and
`amount`; terminal attempts eligible for rebuilding do not require that field.
Retain positional item errors and the `transparent` flag. The backend does not
register per-payment confirm/retry paths.

Public fallback requires explicit `allow_transparent: true`; do not silently add
it on retry or network error. A controlled availability fixture is backend test
evidence, not proof that the real devnet proof program was unavailable.

## Validation ownership

The backend protocol harness uses separate devnet fixture wallets, real Auth,
real signed submissions and finalized chain/account rereads. It can validate
signing protocols while product wallet integration (#78/#80) is unfinished.
These results are distinct from browser E2E and do not establish product signing.
Rerun the browser gate after client schema/protocol changes and real wallet
integration are available. No frontend implementation or mock changes are made
by this backend follow-up.


### Opt-in protocol checks

The ignored integration tests `live_accounts`, `live_payroll`, and `live_consent`
are never run by default. Run them explicitly against a prepared disposable local
Supabase stack and real devnet RPC, serially in this order:

```bash
cargo test --locked --test live_accounts live_canonical_enrollment_and_configure -- --ignored --nocapture
cargo test --locked --test live_payroll live_run_recovery_blocks_uncertainty_and_finalizes -- --ignored --nocapture
cargo test --locked --test live_accounts live_apply_pending_and_durable_receipt -- --ignored --nocapture
cargo test --locked --test live_consent live_public_consent_and_real_fallback_receipts -- --ignored --nocapture
```

Supply `LIVE63_FIXTURE` (private JSON), `LIVE63_API`, `LIVE63_OUTAGE_API`,
`LIVE63_RPC`, and `LIVE63_OUTPUT`. Fixture JSON holds existing admin/fresh recipient
`user_id`, `token`, and private `wallet_file` for each actor, plus `company_id`,
`person_id`, `funder_file`, `supabase_url`, and `anon_key`. Proof/Auth services must
be loopback targets; the harness verifies the full devnet genesis before signing.
Create/accept the recipient through the normal local Auth, people/invite and
`accept_invite` APIs, with no email delivery. Keep credentials/keypairs ignored
and mode 600. Never use a production/hosted fixture or run the whole ignored suite.

The fresh recipient requires SOL funding; fallback funding uses 0.01 test USDC
from the explicit devnet fixture funder and the real public wrap API. The tests
submit 0.001111 confidential and 0.001500 total public wrapped USDC. They retain
the intended submission signature before broadcasting and verify exact wire
bytes, real finalized success, durable API receipts, activation and balances.
The consent check requires a separate same-build service with only proof-program
availability overridden by a controlled RPC relay. Forward all receipt, bank,
blockhash and account reads to real devnet and disclose the override in results.

An interrupted or failed live check may leave a funded account or prepared
request. Inspect retained evidence and reconcile the original submission before
rerunning; these tests intentionally do not reset chain state or replace unknown
attempts. Created account mappings and finalized receipts are retained as durable
fixtures. Remove only owned ephemeral roster/grant fixtures, stop only test
processes, and revoke temporary local Auth sessions when finished.
