# Local live acceptance for issue 58

Seven final scenarios passed on 2026-10-10. The complete migration sequence,
including `20261010000000_chain_indexer.sql`, was applied to the separate
`cadence-indexer58` Supabase stack. The proof service used dedicated runtime
roles, real devnet RPC and a real local Supabase Auth user. The run dashboard
used `NEXT_PUBLIC_API_MODE=real` and owner-scoped database reads. No MSW or RPC
mock participated in these live checks.

| # | Scenario | Observed result | Evidence |
|---|---|---|---|
| 1 | Wrap with immediate confirm | Confirm returned 409 while pending; the signature persisted and the background indexer recorded finalized execution | `devnet-results.json`, wrap receipt |
| 2 | Payroll without client confirm | Actual 2,913-byte confidential v1 transaction was discovered from wallet history; dashboard changed Pending → Confirmed and retained Confirmed after reload | `run-pending-current.jpg`, `run-confirmed-reloaded.jpg` |
| 3 | Standalone transfer without confirm | Actual API-prepared confidential v1 transfer was discovered and finalized | `devnet-results.json`, transfer receipt |
| 4 | Standalone unwrap without confirm | Actual API-prepared withdrawal was discovered and finalized | `devnet-results.json`, unwrap receipt |
| 5 | Failed payment during downtime | A prepared payroll transaction became stale after another transfer and failed on devnet. While the service was stopped, Postgres remained prepared. Startup reconciled the failure before accepting HTTP: the first served read was failed. Dashboard showed Failed, including after reload | `offline-before-restart` and `restart-result` in `devnet-results.json`; `proof-restart.log`; `offline-failed-reloaded.jpg` |
| 6 | Live finalized subscription | A valid signature was pinned before broadcast. The live provider acknowledged `signatureSubscribe` and delivered `signatureNotification`. Stored signature/slot matched; dashboard showed Confirmed after reload | `websocket-evidence.jsonl`, `websocket-result` in `devnet-results.json`, `websocket-confirmed-reloaded.jpg` |
| 7 | Durable events and owner isolation | Six terminal attempts produced six unique events. Repeating all six confirms did not change the outbox. Owner reads succeeded; another authenticated user's Supabase read returned zero rows and proof API read returned 404. Indexer lacked Vault/private-schema and event mutation privileges | `database-result` in `devnet-results.json` |

Every stored receipt was reread through finalized devnet
`getTransaction` with `maxSupportedTransactionVersion: 1`; its slot and success
or failure matched Postgres. The six public transaction references, wire sizes,
versions and receipts are in [devnet-results.json](devnet-results.json).

The WebSocket observation used a temporary transparent relay to
`wss://api.devnet.solana.com`, forwarding real provider messages without
synthesizing replies. Subscription 1811755 delivered the success notification
at slot 509601737. The relay was stopped afterward, and the running proof
service was restored to the direct devnet WebSocket URL. Restart reconciliation
also preserved the outbox unchanged.

Runtime provenance is in [runtime.json](runtime.json): checkout
`/Users/blsoaresdev/cadence`, existing branch `squads_confidential_vault_spike`,
base commit `b092365e1e9dfa35f2765580163112332e4bece5`, serving source and binary
fingerprints, URLs and process IDs. The frontend process working directory was
verified as this checkout's `frontend`; the proof executable ran from its
`services/proof`. The browser was the visible Codex in-app browser with real
email-code sign-in. Application sources stayed fixed during the live scenarios.

Final Rust formatting, all-target compilation and Clippy passed. Twelve ordinary
targeted tests passed in the final rerun, with four database tests explicitly
ignored in that invocation. Earlier in this work, five isolated database tests
were explicitly executed and passed; those results are distinct from the final
rerun. Frontend type checking, ESLint and Prettier on the five changed files,
and 74 targeted tests passed. Neither full test suite was run. Existing vendored
Rust deprecation and Vitest configuration warnings remain.

Preparatory failures were retained in [attempt-notes.json](attempt-notes.json)
rather than counted as successful scenarios.
The initial local configuration omitted the separate wrap PostgREST JWT; it was
corrected before the wrap passed. The disposable recipient setup omitted Token-2022
reallocation before confidential configuration; following the existing wrap
builder's allocation pattern fixed its `InvalidAccountData` error. The first
payroll fixture expired while browser setup was being completed and broadcast
was rejected with `BlockhashNotFound`; its run
`7df20d08-b07a-42fd-94fc-0cb9afb79ce5` remains prepared with no terminal event.
A freshly prepared transaction was then submitted within its validity window
and passed scenario 2. No acceptance assertion was weakened.

The dashboard's run status connection is proven. Browser signing/run creation
still depend on the existing wallet and API integration work (#78, #80, #63).
The shell balance and general payments/receipts APIs are also still missing:
the screenshots show the existing balance error. This validation does not
claim those separate product flows or a hosted deployment are complete.

The local services are left running for inspection:

- Dashboard: <http://127.0.0.1:3000/company/runs/1b989f0c-d12f-4407-b184-cd0db0383de2>
- Proof health: <http://127.0.0.1:3001/health>
- Supabase API: <http://127.0.0.1:58621>
- Database: loopback port 58622; local mail UI: <http://127.0.0.1:58624>

Credentials, sessions and disposable keypairs are confined to ignored local
files under `supabase/.temp/indexer58-local`; frontend public configuration is
in ignored `frontend/.env.local`. The temporary test
`services/proof/tests/live_indexer58.rs` was removed after checking that no
application source referenced it; an ignored copy remains as `live-driver.rs`.
The temporary relay was stopped. Other projects' containers and the user's
existing local edits were preserved. At the end of this live acceptance pass, nothing had been committed, pushed or
published. Later checks from current main are recorded in
[shipping-check.md](shipping-check.md).
