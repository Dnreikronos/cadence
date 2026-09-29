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
and test their own unsigned instruction path. No proof HTTP endpoint, key
storage, or balance resynchronization flow is added by this scaffold.

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
and must never include amounts or secrets. Await `audit::log::append` on an
autocommit `tokio_postgres::Client` before releasing a key, and abort key access
on any error. Never put the insert in a transaction that may later roll back.
The future key-storage integration owns connection setup, TLS, timeouts and
access authorization; no decryption endpoint is added here.

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
