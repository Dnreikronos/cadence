# Proof service

Issue [#48](https://github.com/Dnreikronos/cadence/issues/48). An axum service
with configuration validation, RPC health reporting, graceful shutdown, and
the `spl-token-client` compatibility layer for unsigned transaction v1.

## Run

```bash
export BUILD_SHA=$(git rev-parse HEAD)
export PROOF_RPC_URL=https://api.devnet.solana.com
cd services/proof
cargo run --locked
```

```bash
curl --fail http://localhost:3000/health
```

| Environment | Required / default |
|---|---|
| `PROOF_RPC_URL` | Required HTTP(S) Solana RPC URL |
| `BUILD_SHA` | Required full, 40-character Git revision identifying the build |
| `PROOF_BIND_ADDR` | `0.0.0.0:3000` |
| `PROOF_RPC_TIMEOUT_MS` | `5000`, accepted range 1–60000 |
| `PROOF_CORS_ORIGINS` | `*`; alternatively comma-separated exact origins or empty to disable |

Configuration is checked before listening. Provider URLs and response bodies
are never included in errors because they may contain credentials. No wallet
keypair or viewing key is needed to run this scaffold.

`GET /health` calls Solana `getHealth` with a bounded timeout. A healthy RPC
returns HTTP 200:

```json
{"status":"ok","build_sha":"<40-character revision>","rpc_reachable":true}
```

An unhealthy node, timeout, HTTP failure, or malformed RPC response returns
503 with `status: "unavailable"`, the same SHA, and `rpc_reachable: false`.
Reachability here means a healthy, usable RPC; this is a readiness check, so a
provider outage also makes the service unready. SIGINT and SIGTERM stop
accepting connections and drain active requests.

## Container

From the repository root:

```bash
docker build --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  -t cadence-proof services/proof
docker run --rm -p 127.0.0.1:3000:3000 \
  -e PROOF_RPC_URL=https://api.devnet.solana.com cadence-proof
```

The runtime runs as UID 65532 and includes TLS certificates. The build context
excludes keys, environment files, and local build outputs.

## Checks

```bash
cargo fmt --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Tests use local mock RPCs and require no credentials or public network. CI
runs these checks, builds the runtime image, checks its health against devnet
with bounded retries, and checks a clean SIGTERM exit. That last check depends
on public devnet availability; the unit tests do not.

## Keeping spl-token-client

We retain `spl-token-client` 0.19.1 through a [documented local
patch](vendor/spl-token-client/CADENCE.md). Its proof and balance helpers stay
upstream. The patch makes the legacy RPC dependency optional and exposes
`confidential_transfer_transfer_instructions` before legacy packaging and
signing. The original sending helper delegates to this builder, so there is
one implementation of proof generation.

`solana/token_client.rs` supplies the read-only account adapter and a payer
that has only a public key. Its signing method fails; legacy simulation and
submission also fail. `solana/v1.rs` compiles the returned instructions with
explicit compute and loaded-account budgets, creates empty signature slots,
and enforces the 4096-byte limit. The browser must sign the resulting message.
RPC transaction and block reads centrally declare
`maxSupportedTransactionVersion: 1`.

This patch currently exposes the no-transfer-fee confidential transfer builder
needed by our wrapped USDC mint. Other upstream methods still build legacy
transactions; they are not ready for service use. Later endpoints must expose
and test their own unsigned instruction path. Key storage is described below;
the wrap endpoint is documented at the end of this file. Balance resynchronization
remains separate work.

The local compatibility test invokes the patched helper with real proofs and
checks the unsigned v1 output, proof offsets, mint lookup, and wire limit.
On 2026-09-28, a temporary copy of the existing devnet spike replaced its
transfer builder with this helper and its transaction assembly with
`compile_unsigned`. The test harness signed only after receiving the unsigned
transaction, acting as the external wallet. The 2,395-byte transfer confirmed
at slot 505330225, and the recipient decrypted 4,200,000 units:
[devnet transaction](https://explorer.solana.com/tx/2fMrc3gvo5wAjW8wcXHj68Tw51ERPyh1jRQXdVZH5vQQmYmUBmDTciGtoCw5Pt6VDZPJpZjeJ9KDAesXYZtArNC2?cluster=devnet).
This used a disposable Token-2022 mint; it did not move wrapped USDC or test a
browser wallet integration.

## Decryption audit log

Apply `supabase/migrations/20260928000000_decryption_audit_log.sql` as the
Supabase migration administrator. The runtime must use `service_role`, which
has INSERT permission only on actor, reason and target account. PostgreSQL
assigns the ID and timestamp. Anonymous and authenticated clients have no table
access; RLS is enabled with no client policies. Administrators remain trusted
and can change records or schema. No amount column or metadata payload exists.

`audit::log::AuditEntry::new(actor, reason, target_account)` requires a nonblank
actor/reason and a valid Solana public key. Derive the actor from authenticated
context; do not trust a caller-supplied actor field. Reasons describe operations
and must never include amounts or secrets. `audit::log::append` remains available
for general audit events. Stored viewing keys must use `keys::vault::load`, which
uses the audit module to obtain a committed read permit before decrypting.
Future endpoint integration owns connection setup, TLS, timeouts and account
authorization; no decryption HTTP endpoint is added here.

Run the database test against an **empty disposable PostgreSQL database** as
an administrator. It creates the Supabase roles and applies the migration;
never point it at an existing development or production database. TLS is
disabled only in this local test connection.

```bash
cargo test --locked --test audit
AUDIT_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/audit_test \
  cargo test --locked --test audit -- --ignored
```

CI provisions PostgreSQL 17 and explicitly runs the database test, including
INSERT success, mutation/read denial for the BYPASSRLS service role, denied
client access, attribution constraints, and propagation of failed inserts.

## Encrypted viewing keys

Issue [#50](https://github.com/Dnreikronos/cadence/issues/50) uses **Supabase Vault**
instead of a separate cloud KMS, as agreed for ADR B19. No AWS/Azure account or
external master-key environment variable is required. Apply the audit migration
first, then `supabase/migrations/20260929000000_encrypted_viewing_keys.sql`, using
Supabase's normal `postgres` administrator. Vault 0.3.1 is required; review the
storage implementation before upgrading that extension.

The migration creates `cadence_key_service` with NOLOGIN. Enable login and assign
a password through deployment secret management, then connect the proof runtime
as that role over verified TLS. Do not connect it as Supabase `service_role` or
`postgres`: those privileged roles can read Vault directly. The new role has no
direct access to Vault, metadata, permits, or audit tables. Its only key access
is through three restricted database functions. Metadata and permits have RLS
enabled with no client policies. Existing Vault consumers retain their grants.

`ViewingKey::signing_message(account)` returns the SDK's canonical per-account
message. Have the wallet sign those bytes privately, then call
`keys::vault::enroll(client, wallet, account, signature)`. It verifies the wallet
signature, derives the key, and stores it once; duplicate registration fails
without replacing the key or leaving orphan Vault entries. This signature is
secret derivation material: never publish it, store it, or use a public transaction
signature in its place. Callers must separately authenticate the request and
authorize that wallet for the token account.

Vault's `create_secret` initially writes its input to a heap row before encrypting.
Enrollment therefore creates an **empty placeholder** and calls `update_secret`
to encrypt the real payload before its UPDATE. Both operations occur atomically.
The payload binds the secret to wallet, account, public key, and format version;
Vault also authenticates its record UUID. Only ciphertext and public metadata
are stored. No ElGamal secret or signature is written to a file by this code.

`keys::vault::load(client, wallet, account, actor, reason)` first persists an audit
row and a one-use read permit. The reader requires a committed permit for the
same account, consumes it, and verifies the decrypted payload and public key.
Audit failure prevents decryption; missing/corrupt keys still leave the committed
audit row. Use **autocommit** and do not wrap reads in a transaction: a caller
that manually rolls back permit consumption could replay a permit. Trusted
runtime code must use this accessor, not call the SQL functions independently.
Unused permits from failed reads may be pruned by an administrator; retain the
append-only audit rows.

The key wrapper zeroizes on drop and implements neither Debug nor Serialize.
`with_keypair` lends the SDK keypair to trusted proof code; that code must not
copy, format, serialize, or cache it. The wrapper cannot erase copies in database
driver, network, or PostgreSQL buffers. Keep infrastructure payload tracing,
crash dumps, and secret-bearing application logs disabled.

Enrollment checks PostgreSQL logging settings before sending the key: error
parameter logging must be zero, pgaudit parameter logging off, and parameter
logging either disabled or statement/duration logging disabled for SELECT calls.
The migration sets the new role's error-parameter logging default to zero. If
other deployment settings are unsafe, enrollment fails rather than sending the
secret. All queries use bound parameters; database errors are sanitized.
Administrators, Vault's project root key, and Supabase's broad service role remain
inside the trust boundary. This provides no independent external-KMS boundary.

### Local Vault integration test

Use an isolated container, never an existing development/production database:

```bash
docker run -d --name cadence-vault-test \
  -e POSTGRES_PASSWORD=keys-test-only -e POSTGRES_DB=keys_test \
  -p 127.0.0.1:55450:5432 public.ecr.aws/supabase/postgres:17.6.1.143
# Wait for pg_isready, then prepare the test-only permissions and heap guard:
docker exec -i cadence-vault-test psql -U supabase_admin -d keys_test \
  -v ON_ERROR_STOP=1 < tests/support/vault.sql
VAULT_TEST_DATABASE_URL=postgres://postgres:keys-test-only@localhost:55450/keys_test \
  cargo test --locked --test keys -- --ignored
docker rm -f cadence-vault-test
```

The fixture installs a test-only trigger that verifies every nonempty Vault
write is already authenticated ciphertext before it reaches the heap/WAL.
The integration test runs migrations as the normal postgres administrator and
uses the dedicated runtime role for enrollment and reads. It covers recovery,
duplicate registration, logging settings, direct-access denial, audit failure,
concurrent transaction visibility, permit reuse, and context tampering. CI runs
this against the real Vault extension in a separate job.


## Wrap USDC

`POST /wrap` builds an unsigned v0 devnet transaction that configures the company
ATA when necessary, wraps USDC 1:1 and deposits it into the confidential pending
balance. `POST /wrap/confirm` verifies the finalized transaction and persists
its signature. The browser wallet remains the only signer.

See the [wrap API contract](../../docs/dev/WRAP_API.md) for public setup artifacts,
request/response examples, blockhash retries, the restricted Supabase storage
role, required environment variables and targeted verification commands.
Wrap returns `transaction_version: 0`, needs no lookup tables, and enforces the
1,232-byte limit; larger confidential transfers still use v1. Brave/Phantom
signing and signature-verified devnet simulation passed. Submission and finalized
confirmation remain pending recoverable confidential-key setup; Phantom rejected
the SDK derivation message for the fresh destination. Apply-pending remains #68.


Wrap requests are bounded before RPC work by peer and wallet quotas, a global
quota and a concurrency cap. Expired unsigned preparations are collected after
24 hours by the restricted cleanup function. Apply the wrap cleanup migration
before deploying this version. See the API contract for quota values, delayed
confirmation handling and proxy/replica deployment requirements.
