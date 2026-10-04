# Wrap USDC

Issue [#52](https://github.com/Dnreikronos/cadence/issues/52), with the
[implementation and verification record](../plans/2026-09-29-052-plan-wrap.md).
Both endpoints are devnet-only and never sign or submit transactions. The
company wallet pays SOL fees and must hold Circle devnet USDC in its SPL Token
associated account. The destination is its Token-2022 associated account for
`CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb`.

Apply `supabase/migrations/20260929000001_wrap_requests.sql` before enabling
wrap storage. It creates `cadence_wrap_service`, a NOLOGIN role with RLS policies
and access only to wrap records, and grants role switching to PostgREST's
`authenticator`. Anonymous, authenticated and broad service_role clients have
no table access. Prepared message fields cannot be updated; confirmed signatures
and slots cannot be replaced or cleared. Only the migration administrator may
remove arbitrary records. The cleanup migration below grants only bounded
removal of expired unsigned requests.

| Environment              | Value                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `PROOF_SUPABASE_URL`     | Project HTTPS origin; loopback HTTP allowed for local Supabase                                    |
| `PROOF_SUPABASE_API_KEY` | Project public anon/publishable API key for the gateway                                           |
| `PROOF_WRAP_SERVICE_JWT` | Server-only, project-signed JWT with `role: cadence_wrap_service` and a deployment-managed expiry |

Provision the restricted JWT outside the proof service using the project's
trusted JWT issuer. Supply neither the project JWT signing secret nor a broad
service_role key to the runtime. Refresh this token through deployment secret
management before expiry. Wrap storage uses this dedicated REST credential;
viewing-key operations retain the separate audited key-access boundary from #50.
All three settings are required together. With none, health still works and wrap
endpoints return `503 wrap_storage_unavailable`; partial configuration fails
startup. Provider bodies and credentials are never returned in endpoint errors.

### Request limits and retention

Apply `supabase/migrations/20260930000001_wrap_cleanup.sql` after the wrap table
migration. The service checks the finalized devnet block height once a minute
and calls a restricted cleanup function. Each pass deletes at most 1,000 rows
with no recorded signature, an expired blockhash and a creation time more than
24 hours ago. Confirmed receipts are never deleted. RPC or database failures
skip the pass and log a fixed warning; monitor that warning and table growth.

Confirm submitted transactions within 24 hours. A transaction may have landed
on chain even if its local preparation record was collected. A later 404 is not
evidence that the deposit failed. Reconcile the chain signature before preparing
another deposit.

Both wrap endpoints share fixed 60-second quotas of 120 requests per service
instance and 30 per socket peer, plus a cap of eight active requests. Preparation
also allows ten requests per wallet per window across peers. Limits return 429
with `Retry-After` before Solana RPC or storage work. The global quota bounds the
in-memory peer and wallet maps. Restarting the service resets these quotas.

Forwarded IP headers are deliberately ignored. Behind a proxy, all clients share
that proxy's peer quota, which is conservative but may reject legitimate traffic.
These limits are enforced inside every deployed service instance even without
a gateway. Before scaling to multiple replicas, enforce a shared quota at the
gateway and restrict direct backend access; local limits multiply with replicas.
This repository does not configure a hosted gateway or distributed limiter.

### Browser access (CORS)

`PROOF_CORS_ORIGINS` defaults to `*` for the current integration phase, as
requested. GET and POST are allowed, OPTIONS preflight is handled automatically,
and `Content-Type` / `Authorization` headers are permitted. Preflight can be
cached for 600 seconds. Credentialed cookies are not enabled.

Set a comma-separated list such as
`http://localhost:5173,https://app.example.com` to restrict origins later.
An explicitly empty value disables cross-origin access. List entries must be
exact origins with no path, trailing slash, query or wildcard suffix. Invalid
configuration fails startup. CORS controls browser access; it does not replace
authentication or wallet-signature verification.

### Prepare and sign

`POST /wrap` accepts an integer base-unit string, with six USDC decimals:

```json
{ "company_wallet": "<wallet public key>", "amount": "1000000" }
```

For an unconfigured destination, include `setup`:

```json
{
  "company_wallet": "<wallet public key>",
  "amount": "1000000",
  "setup": {
    "pubkey_validity_proof": "<base64 PubkeyValidityProofData bytes>",
    "decryptable_zero_balance": "<base64 PodAeCiphertext bytes>"
  }
}
```

The activation flow produces these public artifacts using the company's
**enrolled** keys for the destination ATA: the SDK's
`build_pubkey_validity_proof_data(&elgamal_keypair)` and
`aes_key.encrypt(0)` converted to `PodAeCiphertext`, then base64 of each POD's
bytes. The service verifies the pubkey proof. Only the wallet can validate that
the AES ciphertext encrypts zero under its own key; it must construct this
ciphertext correctly. Never send a wallet private key, ElGamal secret, AES key or
key-derivation signature to these endpoints. This issue implements the backend
contract; browser activation/proof packaging and Vault enrollment remain their
own integrations. If already configured, omit setup; supplying a proof for a
different ElGamal public key is rejected.

The transaction creates the ATA if necessary, reallocates and configures the
confidential extension when absent, wraps USDC 1:1, then deposits the amount into
the confidential **pending** balance. The wallet is the only signer. Deposits
remain public by design, and spending the pending balance requires #68's
apply-pending flow. No funds become available for payroll just by confirming.
Amounts must be between 1 and 281474976710655 base units (the deposit's 48-bit
limit). Existing accounts must have the expected mint, owner and initialized
state, and the confidential destination must accept another pending credit.

The response contains:

```json
{
  "request_id": "<64-character request hash>",
  "transaction": "<base64 unsigned v0 wire transaction>",
  "transaction_version": 0,
  "required_signers": ["<company wallet>"],
  "destination": "<Token-2022 ATA>",
  "mint": "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb",
  "recent_blockhash": "<blockhash>",
  "last_valid_block_height": 123,
  "deposit_state": "pending_after_confirmation"
}
```

Wrap uses v0 without address lookup tables, with explicit compute and loaded-account
budgets and a strict 1,232-byte wire limit. Fresh-account setup measures 812 bytes.
Larger confidential-transfer transactions retain the separate v1 compiler.

Have the wallet sign the exact returned message and submit it to devnet. Do not
replace its blockhash or instructions: confirmation binds to that message.
After expiry, request a new transaction and signature. An identical preparation
has the same request ID and cannot erase a previous confirmation. A fresh
blockhash makes a distinct request; reconcile an already submitted transaction
before creating another deposit to avoid depositing twice.

### Confirm

`POST /wrap/confirm`:

```json
{
  "request_id": "<returned request ID>",
  "signature": "<submitted transaction signature>"
}
```

The service reads the finalized base64 transaction with
`maxSupportedTransactionVersion: 1`, verifies successful execution, the exact
prepared message and the wallet signature, then stores signature and slot.
Confirmation also accepts previously prepared v1 records.
Success returns `request_id`, `signature`, `slot`, and `status: "finalized"`.
Repeated confirmation returns the persisted receipt even if RPC history is no
longer available. A failed database write does not return success.

Errors are fixed `{ "error": "<code>" }` objects without amounts. Malformed
requests return 400; unknown request IDs return 404; missing setup, insufficient
USDC, unavailable confidential credits, nonfinalized/failed/mismatched
transactions and conflicting receipts return 409; RPC/storage outages return 503. `transaction_not_finalized` can be retried. `confidential_setup_required`
requires activation artifacts, not a server-generated viewing key.

Assembly uses public data and does not require a user JWT. Signing the returned
transaction authorizes funds movement. Anyone may relay a signature to confirm
that public fact, but cannot list records through this service or read viewing
keys. Supabase user authentication and company membership routing remain #63
and #75; these endpoints do not assert that a wallet belongs to a company.

### Local verification

```bash
cargo test --locked --test wrap_builder --test wrap_http --test wrap_storage
```

The default tests use local mock servers. For the migration test, use an empty,
disposable PostgreSQL cluster with no existing Supabase roles:

```bash
docker run -d --name cadence-wrap-test \
  -e POSTGRES_PASSWORD=wrap-test-only -e POSTGRES_DB=wrap_test \
  -p 127.0.0.1:55452:5432 postgres:17
# Wait until pg_isready succeeds, then:
WRAP_TEST_DATABASE_URL=postgres://postgres:wrap-test-only@localhost:55452/wrap_test \
  cargo test --locked --test wrap_storage wrap_records -- --ignored
docker rm -f cadence-wrap-test
```

The additional ignored `postgrest_persists` test takes `WRAP_TEST_SUPABASE_URL`,
`WRAP_TEST_API_KEY` and `WRAP_TEST_SERVICE_JWT` for a disposable migrated Supabase
REST endpoint. It checks persistence, concurrent confirmations and prepare
retries against real PostgreSQL/PostgREST. Both ignored tests were run locally;
the database-permissions test is also configured in CI.

Brave/Phantom signed an actual backend-produced v0 transaction, and devnet
`simulateTransaction` with `sigVerify: true` succeeded at slot 505718611
(812 bytes, 63,633 compute units). Phantom must be in Testnet Mode with Solana
Devnet selected; mainnet mode produced a wallet simulation failure.

Full submission and finalized confirmation remain unverified with this wallet.
Phantom rejected the SDK's canonical per-account key-derivation message with
`You cannot sign solana transactions using sign message`. Signing validation
therefore used temporary public setup artifacts, with broadcasting disabled.
Do not submit such a transaction: the temporary decryption keys were discarded.
A real deposit requires recoverable enrolled keys and their public setup
artifacts, or an already configured destination. Do not change the canonical
message to work around wallet rejection; that changes the derived keys. No
hosted Supabase migration was performed.
