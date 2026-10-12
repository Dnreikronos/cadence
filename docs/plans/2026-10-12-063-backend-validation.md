# Backend contract validation

Backend work for #63 was prepared on `proof_web3_contract_recovery` from
`origin/main` at `c38bd22`. The branch retains the merged indexer's bounded
history scanning, scan checkpoints, expiry scheduling and WebSocket isolation.
It also retains the merged migration versions and pinned CI actions. Frontend
and wallet-provider spike changes in the original checkout were left untouched.

Every implementation commit was compiled as its own staged snapshot in an
isolated checkout. Final local checks include all-target compilation, formatting,
Clippy with warnings denied, and targeted HTTP, transaction-builder, auth,
CSV, RPC and database tests. There were 68 distinct passing tests across 19
integration-test targets, two filtered library runs and nine explicit database
suites. Eight database-dependent cases were ignored by the ordinary invocation
and run explicitly in the dedicated database checks. The vendored token client has an existing nonfatal
deprecation warning. The unrelated full test suite was not run.

Nine database suites passed against a disposable Supabase PostgreSQL/Vault
container, with a fresh database and runtime roles for each suite. They cover
run recovery, account lifecycle, owner reads/roster/CSV, explicit fallback consent,
indexer recovery (including the existing history/scheduling regressions), auditor
exports, positional run confirmation, standalone transfers and withdrawals.
The owner-read suite also passed with a plain loopback fixture URL, matching CI.
Fixture setup was corrected to apply the auditor receipt view before public
fallback metadata. Applying those migrations in reverse order removes the
`transparent` column. Private read fixture checks explicitly disable TLS only on
the loopback connection, consistent with the existing harness.

The previous skel-test run on 2026-10-12 used the original dirty checkout at
`b092365` with Alchemy devnet. Its 27 focused backend tests and all four native
protocol flows passed. Configure, confidential payroll, apply-pending and public
fallback used real signed submissions, exact finalized wire verification and
durable API/account rereads. Only proof-program availability was overridden for
the public consent case; submission and finality remained real devnet reads.
Those live protocols were not rerun after moving the work onto current main.

That browser gate recorded three passes, three failures and four blocked signing
flows. Legacy nullable counterparty IDs and unset roster amounts were rejected by
frontend schemas; the history error also hid the export button. Signing flows
were blocked by the unavailable real wallet provider and remaining client
integration. These findings remain frontend work and are described in the
[handoff](../dev/WEB3_INTEGRATION_HANDOFF.md). Backend protocol passes do not
establish browser signing or the issue's shared frontend/backend agreement.

Detailed local evidence is retained in the original checkout's
`docs/plans/e2e-63-validation-2026-10-12` directory. Raw browser traces, sessions,
provider environment files and wallet keypairs are excluded from the branch.
No hosted migration or deployment was performed. The disposable shipping test
container was removed after validation; existing local Supabase stacks were
preserved.

## CI follow-up

The first GitHub run had two actual failures. The tenant test reproduced an
activation-trigger permission error because its shared SQL OR expression planned
a protected account-table read even for service_role. Separate PL/pgSQL role
branches preserve activation without granting account access. The tenant suite
includes an explicit denial check and all 136 database assertions pass locally.

The concurrent recovery job timed out at pg_advisory_xact_lock while the first
request was generating proofs. A controlled six-second owner hold reproduces
that failure. The lock wait now uses the existing 30-second HTTP budget, then
restores five-second statement and lock limits before ordinary reads. The
regression verifies the original payload, restored settings, cancellation
cleanup, one run and one audited key read. It passes with the correction.

The remaining eight red Vault jobs were cancelled by matrix fail-fast, rather
than separate test failures. Compiler, formatter and Clippy checks passed again;
account lifecycle and fresh-migration tenant checks were also rerun. No frontend
or hosted-data changes were made.
