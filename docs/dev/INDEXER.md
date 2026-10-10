# Chain indexer (#58)

The proof service indexes payroll run payments and standalone wrap, transfer and
unwrap requests. Apply `20261010000000_chain_indexer.sql` after the unwrap
migration, then `20261010000001_indexer_scan_checkpoints.sql` before starting
the updated worker. The first migration creates `cadence_indexer` with NOLOGIN: enable login
and assign its password through deployment secret management, then supply
`PROOF_INDEXER_DATABASE_URL` using that role. Verified database TLS is required
outside loopback. The role can read public transaction metadata, update receipt
columns and manage history cursors; it has no Vault or viewing-key privileges.

| Setting | Behavior |
|---|---|
| `PROOF_INDEXER_DATABASE_URL` | Required whenever wrap or transfer storage is enabled |
| `PROOF_RPC_WS_URL` | Optional; defaults to the RPC URL with `http`/`https` replaced by `ws`/`wss` |

Set the WebSocket URL explicitly when the provider uses a different endpoint or
port. Both endpoints must describe the same devnet cluster. With no payment
storage and no indexer database setting, the health-only scaffold stays enabled.

## Submission and recovery

Existing `/confirm` request and response shapes remain compatible. The service
verifies the supplied wallet signature against the exact prepared message and
persists `submitted_signature` before confirmation RPC calls. A pending or
unavailable RPC response preserves that signature for background indexing.
Callers can send confirm immediately after broadcast; they need not keep asking
the chain for dashboard status. Terminal receipts remain immutable, and failed
standalone confirmations return `409 transaction_failed` on later reads.

Clients that close before sending confirm leave no signature. The indexer
discovers those transactions through paginated finalized wallet history,
reconstructs the unsigned request hash, verifies the exact prepared message and
wallet signature, and records the result. Discovery uses each request's stored
blockhash expiry to bound relevant history, with a conservative 300-block
allowance before expiry and 150 blocks after it. Finalized block headers provide
block heights; slots and wall clocks cannot safely substitute for heights.
Transaction bodies outside all pending windows are skipped. A pruned older
block can be skipped when the first retained block proves it predates every
pending window. Missing relevant history still prevents startup readiness.

Successful pages save `scan_head` and `scan_before`, independently of the
completed wallet `signature`. A later-page failure resumes from that checkpoint.
After resuming, a fresh bounded pass catches activity that arrived during
downtime. Full recovery revisits the pending windows rather than stopping at the
completed cursor, since a preparation can commit after an earlier pending read.
Use a provider that retains the relevant history. Header lookups retry throttling
twice, honoring numeric `Retry-After` values up to 60 seconds or using bounded
backoff. Longer cooldowns and exhausted retries preserve the checkpoint and
fail readiness. Other RPC reads retain their existing timeout behavior.

Startup reconciliation completes before the HTTP listener binds. An RPC,
storage or verification error prevents startup instead of exposing stale
receipts. Missing finalized history for a tracked signature keeps its payment
prepared, even beyond blockhash expiry. Absence does not prove nonexecution.
[Issue #147](https://github.com/Dnreikronos/cadence/issues/147) separately owns
the frontend's standalone retry decision.

The worker refreshes active finalized subscriptions every five seconds.
Notifications, receipt verification and periodic discovery run independently,
so a slow or failed wallet scan cannot block the socket or a notification's
receipt. Active recovery runs every thirty seconds; full recovery, including old
unresolved requests, runs every five minutes. Fast work excludes requests once
finalized height exceeds their expiry plus a 150-block grace period. Their status
stays prepared and the slower pass can still recover a transaction that landed
during downtime. Fast unsigned scans leave durable page checkpoints alone.
Provider errors and URLs are never logged. Shutdown aborts all worker loops
after HTTP requests drain.

## Database status and events

Run status stays derived from payment rows. `GET /runs/:id` reads Postgres only;
authenticated owners may also read their payment rows through existing RLS.
The run dashboard refreshes the existing `GET /runs/:id` metadata API every five
seconds while a payment is prepared, and on mount, focus or reconnect. It stops
periodic reads once all payments are terminal. An initial retryable failure
without cached data also keeps polling; permanent access or missing-run errors
stop. The API derives run status from
Postgres and does not query Solana.
The migration adds `payments` to `supabase_realtime` when that publication exists.
Standalone request tables use `prepared`, `finalized` and `failed`; only
finalized transfers enter incoming-payment history or receive a `paid_at` stamp.
Tracked wrap requests survive the unsigned preparation cleanup TTL.

Each transition from prepared to finalized/failed inserts one row in
`payment_events`, atomically with the receipt. HTTP confirmations and indexer
updates share this trigger. Events include `kind`, `request_id`, `user_id`
(null for wraps), wallet, destination, optional run/position, attempt, status,
signature, slot and database timestamp. `(kind, request_id)` prevents duplicate
events for an attempt. There is no arbitrary payload, amount or chain error.
Previous run attempts retain submission evidence when retried.

`NOTIFY cadence_payment_events` is a wakeup with an empty payload. The durable
table is the event contract for #69: grant a dedicated consumer SELECT access
and its own RLS policy, retain its delivery checkpoints independently, and
filter successful `run`/`transfer` events for payment notices. The indexer
contains no email logic and has no event UPDATE/DELETE permission. Existing
receipts from before this migration are not retroactively emitted.

## Local verification

The integration test requires an **empty disposable Supabase PostgreSQL
instance**, with `tests/support/vault.sql` applied as `supabase_admin`.

```sh
cargo fmt --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --test indexer --test wrap_http --test runs_http --test transfer_http --test unwrap_http
INDEXER_TEST_DATABASE_URL=<empty disposable PostgreSQL URL> \
  cargo test --locked --test indexer -- --ignored
```

The test signs real SDK v0/v1 messages against mocked RPC/WebSocket endpoints.
It checks all four request kinds, pending signatures, short-page pagination,
immutable/idempotent receipts, outbox rollback, missing/malformed history,
subscriptions, disconnects, restart reconciliation before listening, permissions
and an explicit schema allowlist. Review regressions cover pruned irrelevant
history, durable page resume, preparations behind an earlier completed cursor,
expiry filtering and unsubscribe behavior, socket/receipt delivery during a
failing history request, and slow recovery of expired requests. An RPC unit test
covers header throttling, retry exhaustion and unchanged ordinary read deadlines.
It does not establish live provider or hosted
deployment acceptance. CI runs it in its own disposable Vault matrix job.

Live local validation on 2026-10-10 applied all migrations to a separate Cadence
Supabase stack, configured the dedicated runtime roles, and executed actual
API-prepared wrap, confidential payroll/transfer and unwrap transactions on
devnet. History discovery, a live finalized subscription notification, failed
execution during downtime, startup reconciliation, event idempotency and owner
isolation passed. The connected run dashboard retained Confirmed and Failed
after reload. [Report and public transaction evidence](../plans/e2e-58-2026-10-10/report.md).
Browser wallet configuration and the other dashboard API flows are outside these
status checks; no hosted deployment was changed. Shipping checks against current
main are recorded in [shipping-check.md](../plans/e2e-58-2026-10-10/shipping-check.md).
The follow-up [review check](../plans/e2e-58-2026-10-10/review-check.md) records
bounded recovery, scheduling, actual provider throttling and automatic dashboard
recovery from an initial outage.
