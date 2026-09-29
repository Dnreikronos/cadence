# Decryption audit log

Issue: https://github.com/Dnreikronos/cadence/issues/49. Implements ADR B19 and PRD R11.

## Contract

Record actor, reason, target Solana account, and a database-generated timestamp.
Actor is a nonblank authenticated user/service identity supplied by trusted calling
code. Reason is a nonblank operation description, never an amount, secret, or
arbitrary request payload. No amount or free-form metadata column exists.
The Rust API rejects blank attribution and invalid target keys before SQL.
Database constraints independently reject blank fields. The accessor awaits the
insert and propagates failure; future key access must call it successfully before
releasing secrets. This issue adds no key access or authentication endpoints.

Use a supplied tokio-postgres Client so connection credentials and production TLS
remain the responsibility of the future database connection setup. Call with an
autocommit connection; do not wrap audit inserts in business transactions that
could later roll back. Never proceed to decrypt on an audit error.

The migration owner is a trusted administrator distinct from service_role.
Revoke all table permissions from PUBLIC, anon, authenticated, and service_role,
then grant only INSERT to service_role. Enable RLS with no client policies;
Supabase service_role bypasses RLS. Do not grant schema creation rights here.
Administrators can still change the schema or records; this does not claim
cryptographic tamper evidence against a database administrator.

## Verification

Run format, compiler, Clippy, and targeted Rust audit tests. A real disposable
Postgres integration test applies the migration under an administrator, switches
to a Supabase-like BYPASSRLS service role, inserts via the Rust accessor, and
proves SELECT, UPDATE, DELETE, TRUNCATE and caller timestamps are denied.
Also test invalid attribution in Rust and SQL, anonymous/authenticated isolation,
and propagation of insertion failures. Run the database test explicitly in CI.

## Local evidence

Formatting, `cargo check --locked --all-targets`, and
`cargo clippy --locked --all-targets -- -D warnings` passed. The existing vendored
Solana deprecation warning remains. The targeted audit validation test passed;
the explicitly selected database test passed against disposable PostgreSQL 17,
including privilege revocation after permissive default grants. The full test
suite was not run locally. CI was updated but no remote run is claimed.
