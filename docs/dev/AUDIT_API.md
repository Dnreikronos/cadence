# Auditor payments and grants

Issue [#59](https://github.com/Dnreikronos/cadence/issues/59), PRD R4. Apply
`20261010000001_auditor_grants.sql` after the preceding migrations, including #58.
Enable LOGIN and provision a password for `cadence_audit_service` through deployment
secret management. Set `PROOF_AUDIT_DATABASE_URL` to a connection using that exact
role, plus `PROOF_SUPABASE_URL` and `PROOF_SUPABASE_API_KEY` for verified user
authentication. Connections require verified TLS outside loopback. Without the
audit database setting, these routes return `503 audit_unavailable`.

On local Supabase, use `sslmode=disable` explicitly for a loopback connection.
Check `has_schema_privilege('cadence_audit_service', 'auth', 'USAGE')` after
applying the migration. A runner without grant options on the managed Auth
schema can finish with a warning while leaving that grant unapplied. If the check
is false, run the migration's `GRANT USAGE ON SCHEMA auth TO cadence_audit_service`
as the Auth schema owner (`supabase_admin` on the local stack). Keep the dedicated
role without BYPASSRLS; granting it a wider service role is unnecessary.

The runtime has RLS-scoped grant and membership access and two restricted Vault
accessors. It cannot read unscoped receipts, Vault, viewing-key metadata, permits
or audit rows directly. It cannot create viewing keys or obtain unrestricted key
permits. Authentication uses Supabase's `/auth/v1/user`, never unverified JWT claims.
No wallet, wallet signature or RPC call is required for an auditor.

## Read company payments

`GET /audit/:company/payments?limit=20&cursor=<payment UUID>` returns:

```json
{
  "items": [{
    "payment_id": "10000000-0000-4000-8000-000000000003",
    "run_id": "<UUID or null>",
    "counterparty": { "id": null, "name": "<destination account>" },
    "amount": "4200000",
    "status": "confirmed",
    "transparent": false,
    "paid_at": "2026-10-10T12:00:00.000000Z",
    "signature": "<finalized signature>"
  }],
  "next_cursor": null
}
```

This endpoint reads finalized confidential payroll payments and standalone
transfers from stored, verified receipts. Prepared and failed transactions do not
represent payments and are excluded. It decrypts the sender handle of the proof
context tied to the receipt's sender account and wrapped-USDC mint. An unrelated
viewing key or the same public chain access gives no amount. No mint-wide auditor
key is used.

The caller must have both auditor membership and an explicit grant for the
requested company. Missing, revoked and wrong-company grants return the same
`404 audit_not_found`. A valid admin login does not confer auditor read access.
Amounts appear only in successful responses as base-unit strings and are zeroed
when the response model drops. Every response, including errors and grant
administration, sets `Cache-Control: no-store`.

Recipient IDs and names are resolved from the company's people, wallet ownership
and enrolled token-account metadata when available. Otherwise `counterparty.id`
is null and its name is the destination address. No synthetic person ID is used.
This nullable ID is a difference from the web app's current proposed payment
schema; frontend integration must accept it or resolve the recipient first.

Pagination sorts by payment UUID, ascending, and continues strictly after the
cursor. `limit` defaults to 20 and accepts 1–100; `next_cursor` is the last returned
ID when another page exists. UUIDs must be non-nil. Malformed paths, pagination,
duplicate query fields and unknown query fields return `400 invalid_request`.
Four page reads may decrypt concurrently; excess concurrency returns
`503 audit_unavailable`. Authentication failures return `401 authentication_required`.

Company attribution is stored on new runs and standalone transfers at preparation
and cannot change with the payer's membership, wallet or account. Only an admin
membership supplies a company ID. Historical receipts without that attribution
remain excluded: today's membership cannot prove their company at preparation.
Deployments needing historical attribution must establish it from trusted
historical evidence in a separate migration. Recipient-originated transfers are
outside company audit history.

## Audit persistence

Each authorized page request, including an empty page, commits exactly one row to
#49's `decryption_audit_log` before any Vault decryption. Its actor is the verified
user UUID, reason is `read company payments`, and `target_company` is the company
UUID. Account reads retain `target_account`; an audit row must have exactly one
of these targets. No amount, ciphertext, error payload or secret enters this log.

A private permit pins at most 101 receipt IDs (100 items and one lookahead), the
user and company, issuing transaction and five-minute expiry. The reader rejects
uncommitted, expired, replayed, wrong-user or wrong-company permits and checks the
grant again before key access. The lookahead item does not decrypt a key. Multiple
sender keys share the request's one audit row. Failure to persist the log prevents
decryption; a later key/proof failure leaves the committed row and returns a fixed
`503 audit_unavailable`. Denied requests decrypt nothing and create no decryption
audit row. No decrypted cache or plaintext database column exists.

## Admin grant API

These routes manage existing auditor identities. #85 owns the designation UI and
#69 owns invitation email delivery; these APIs do not send messages or return
invitation tokens. Accepted auditor memberships automatically create a grant,
including existing auditor memberships when this migration applies. Revocation
removes the grant while preserving the membership, allowing explicit re-granting.

| Route | Request | Response |
|---|---|---|
| `GET /company/auditor-grants` | optional `limit` / grant-ID `cursor` | `200 { "items": [<grant>], "next_cursor": null }` |
| `POST /company/auditor-grants` | `{ "auditor_id": "<user UUID>" }` | `201 <grant>` |
| `POST /company/auditor-grants/:id/revoke` | no body | `200 { "status": "revoked" }` |

A grant contains `id`, `company_id`, `auditor_id` and `granted_at`. Grant lists use
the same ascending UUID pagination. The company comes from the authenticated
admin's membership, never a request field. Creation requires an existing auditor
membership in that company. A duplicate grant returns `409 auditor_already_active`.
Missing or cross-company identities and grant IDs return `404 audit_not_found`;
a repeated revoke also returns 404. Non-admin callers receive `403 forbidden_role`.
Malformed UUIDs, missing or unknown JSON fields return `400 invalid_request`.
These operations decrypt nothing and add no decryption audit rows. The same RLS
rules also govern authenticated Supabase SQL access to the grant table.

## Verification

`supabase/tests/auditor_grants_test.sql` verifies 21 permission and company-scope
assertions. `audit_http` tests configuration, errors and sender-handle binding.
`audit_storage` explicitly runs against an empty disposable Supabase/Vault
instance with `tests/support/vault.sql` applied and the `AUDITOR_TEST_DATABASE_URL`
administrator connection supplied. Never use an existing development or hosted
database for this test; it applies all migrations and intentionally removes keys.

The integration test covers multiple keys in one page, payroll and standalone
receipts, failed/prepared exclusions, paging and empty reads, admin grant lifecycle,
identical credentials after revocation, permit commit/expiry/replay/user/grant checks,
immutable attribution and failure before/after audit persistence. CI runs it in an
isolated Vault matrix entry. These Rust tests use real Vault and cryptographic
proof fixtures with synthesized finalized receipts.

A separate [live devnet acceptance run](../plans/e2e-59-2026-10-10/report.md)
submitted a fresh confidential payment of 12345 base units. The auditor read that
exact amount and its finalized signature in headed Chromium. After the admin
revoked the grant, the same bearer returned 404 while Supabase still accepted it
for the same user. Reload and database rereads confirmed the grant stayed absent;
denied reads added no audit row. All three required flows passed, including the
other-company denial. The local migration was applied; no hosted migration or
deployment was performed.
