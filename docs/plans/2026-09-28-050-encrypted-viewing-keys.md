# Encrypted viewing keys

Issue: https://github.com/Dnreikronos/cadence/issues/50. Implements ADR B19 and
builds on the audit accessor from #49.

## Contract

Derive an ElGamal keypair from a wallet signature over the SDK's canonical
`solana-conf-bal/v1 || token_account` message. Verify the signature against the
wallet public key and exact account before deriving. Reuse the pinned SDK's
HKDF derivation so the same signature recovers the same public and secret key.
Wallet signing keys never enter this API. The derivation signature itself is
secret material and must never be persisted or logged.

Wrap secrets in a type with zeroization on drop and no Debug, Display, Clone,
or Serialize implementation. Keep raw byte access internal to the key module;
expose only the public key and the scoped SDK access needed by proof generation.
Do not cache decrypted keys. Errors contain fixed descriptions, never provider
responses, signatures, plaintext, or key material.

The user selected Supabase Vault instead of a separate cloud KMS. This replaces
issue #50's envelope/KMS requirement: Vault's project root key protects the
viewing secrets, with database administrators inside the trust boundary. No
AWS/Azure account, external KMS client, or additional master-key environment
variable is required.

Use Vault 0.3.1's supported API without persisting a secret in plaintext.
`vault.create_secret` inserts its argument before encrypting, so call it only
with an empty placeholder; `vault.update_secret` encrypts the real payload
before UPDATE. A test trigger authenticates every nonempty value before it can
reach the heap/WAL. Include wallet, account, public key, and format version in
the encrypted payload and verify them on read. Vault binds ciphertext to its
UUID using authenticated encryption. The metadata table contains only public
identifiers and the Vault record ID. Review this path before upgrading Vault.

Use a dedicated `cadence_key_service` role, with no direct Vault access. Apply
the migration as Supabase's normal postgres administrator; it does not need
superuser privileges or access to Vault's internal encryption functions.
Supabase's existing service_role and administrators remain privileged and must
not be used by the proof runtime. Enable RLS on metadata and read permits, with
no client policies or direct table grants. Grant the runtime only three
SECURITY DEFINER functions in a private schema: store, audit/issue a read permit,
and consume a permit/read. Set an empty search_path and qualify database objects.
Do not change extension-owned Vault ACLs used by other services.

The audit module validates attribution and calls the audit/permit function.
That function inserts the same #49 audit fields and returns an opaque permit.
The read function requires a committed permit matching the account and consumes
it before decrypting. Check its full top-level transaction ID against both the
current transaction and snapshot; xmin can be a subtransaction ID. The Rust accessor awaits audit success before invoking
read, and uses autocommit for both calls. Attempts, including missing keys and
failed decryption, therefore leave an audit row. No direct decryption entry
point is exposed to the runtime. Runtime code is trusted not to manually wrap
permit consumption in a transaction and roll it back to replay a permit.

Authenticated application code supplies the authorized wallet/account and
actor/reason; no HTTP key endpoint is added. Wallet signatures prove wallet
control, not ownership of arbitrary token accounts; callers must establish
account authorization. Connection setup owns production TLS/timeouts. Use bound
parameters and sanitize SQL errors inside the functions. Enrollment refuses
sessions that log parameter values: error parameter logging must be zero,
pgaudit parameter logging off, and statement/duration logging must either omit
parameters or be disabled for the SELECT-based storage call. Driver/Postgres buffers are outside the Rust
wrapper's zeroization guarantee; administrators must keep tracing/core dumps
and infrastructure payload logging disabled for this path.

## Verification

Targeted tests cover deterministic derivation and SDK compatibility, invalid
signatures and account binding, secret trait restrictions, Vault round trips,
tampering and record swaps, database errors, and audit-before-decrypt ordering.
A disposable PostgreSQL test applies both migrations, checks RLS/privileges and
ciphertext-only storage, and verifies each read leaves an audit row while audit
failure blocks decryption. Run formatting, compiler, Clippy, and targeted tests.
Use the actual Vault extension in disposable Supabase PostgreSQL, not a mock.
Check database dumps and logs for the test secret. Record local evidence separately
from hosted deployment validation.

## Local evidence

Formatting, `cargo check --locked --all-targets`, and
`cargo clippy --locked --all-targets -- -D warnings` passed. The existing
vendored Solana deprecation warning remains. Both derivation tests and the
targeted audit validation test passed. The Vault integration test passed against
disposable Supabase Postgres 17.6.1.143 with Vault 0.3.1, including the heap guard
and concurrent transaction regression. An unfiltered SQL dump and combined
container stdout/stderr logs contained neither the surviving test key nor its
decrypted payload. Workflow YAML parsed successfully. The full test suite was
not run; no hosted migration or remote CI run is claimed.
