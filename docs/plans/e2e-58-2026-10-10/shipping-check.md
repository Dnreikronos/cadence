# Shipping checks from current main

The PR branch `proof_chain_status_recovery` starts from current main at
`f3f198811bfd7b5bddd27df4a3d95b1b1add5e35`. The original checkout and its separate local edits
were preserved. The attached worktree is
`/Users/blsoaresdev/.codex/worktrees/proof-chain-status/cadence`.

The backend implementation and migration are byte-for-byte the sources used
for the earlier live devnet acceptance. Current main already speaks the backend
run contract, so the temporary Supabase dashboard adapter from the older checkout
is excluded. The existing run API now refreshes every five seconds while a payment
is prepared and rereads on mount, focus and reconnect. Terminal runs stop periodic
reads. Query tests cover mixed outcomes, cache reopening, failed refreshes and
unknown future statuses.

Rust formatting, all-target compilation, Clippy with warnings denied and 12
ordinary targeted tests passed in this worktree. The indexer integration test
was also explicitly executed and passed against a newly created disposable
`supabase/postgres:17.6.1.143` container, including real database migrations,
concurrent receipts, permissions, event rollback, WebSocket hints and startup
reconciliation before the actual executable opens its listener. That container
was removed after the check. This is separate from the five database tests in
the earlier live report.

Frontend type checking, ESLint and Prettier on the two changed files passed,
with 84 tests across the run query, API client and progress files. No full suite
was run. The workflow YAML parsed and the branch diff passed the whitespace check.

A binary built from this worktree was started on loopback port 3003 using the
existing restricted roles and migrated local Supabase database, with direct live
devnet HTTP/WebSocket endpoints. Startup reconciliation finished before readiness;
health reported the shipping commit and reachable RPC. The dashboard from this
worktree ran in real mode on port 3002 with the existing local test account.

The live finalized subscription run showed Confirmed and retained it after reload,
and the downtime-failure run showed Failed and retained it after reload. Public
observations are in [shipping-confirmed.jpg](shipping-confirmed.jpg) and
[shipping-failed.jpg](shipping-failed.jpg). The database still held exactly the
six original terminal events, unchanged in every field. The indexer still lacked
Vault schema access. Runtime metadata and binary fingerprint are in
[shipping-runtime.json](shipping-runtime.json).

Browser signing remains unavailable in this local runtime; no amount or signer
data was added to the dashboard read. The status checks do not validate the other
product flows or a hosted deployment. Temporary shipping servers are stopped
after checking, leaving the original dashboard and proof service running.
