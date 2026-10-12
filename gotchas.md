# Gotchas

- Keep chain recovery outside the WebSocket receive loop and notification receipt
  path. Expired requests need slower recovery, not endless fast polling or an
  inferred failure. Bound history using block heights rather than slots, save
  descending page progress separately, and revisit pending windows when new
  preparations can commit after a scan starts. Check real provider throttling
  as well as mock responses when adding block-header reads.

- For #58, include standalone wrap, transfer and unwrap indexing as well as
  payroll runs. #147 addresses safe standalone retries, not background status
  indexing; check adjacent issue scope before splitting that work out.

- Authenticate the caller and authorize wallet ownership before charging a
  per-wallet quota. Rejected ownership checks must not spend another wallet's
  budget. Quota regression tests must reuse the same router across callers;
  rebuilding it resets the limiter and hides this failure.

- Payment-run retries cannot infer nonexecution from a null finalized RPC lookup,
  even after blockhash expiry. Preserve unresolved attempts until finalized
  evidence is available, and isolate their errors after finalized expiry so
  eligible payments can rebuild from fresh sender state. Keep live prepared
  payments blocking retries, and return signing payloads only for rebuilt
  positions. Bound recipient RPC reads separately from CPU proofs
  and acquire the shared proof permit after the RPC fetches.

- Before claiming provider credentials are missing, check the project's ignored
  `.env` files as well as the process environment, including the checkout used
  for the previous experiment. Inspect setting names/presence without printing
  values. New worktrees do not copy ignored credentials.

- For #51, Turnkey is selected after a confirmed confidential v1 transfer on
  devnet. This supersedes the earlier Phantom-only preference. Keep production
  embedded onboarding and custody review open; the root-key spike does not
  establish user-controlled signing. Update earlier guidance when a decision
  changes so future work does not follow a superseded scope.

- For #50, the user does not want to provision AWS, Azure, or a similar cloud
  account for key management. Establish the operational constraint before
  offering provider choices. Prefer existing infrastructure where appropriate,
  and explicitly explain any change to the issue's separate-KMS requirement.

- Supabase's `postgres` role is not the extension superuser. Test migrations with
  hosted-equivalent grants. Vault 0.3.1 `create_secret` temporarily inserts its
  argument in plaintext; create an empty placeholder and use `update_secret`
  for the real payload. Do not assume the low-level encryption function is
  available to hosted migrations.
- PostgreSQL snapshots omit the current transaction from the in-progress set.
  A durable audit gate must exclude its own top-level transaction explicitly;
  test with a concurrent transaction advancing the global ID counter. Do not
  use tuple xmin for this check because PL/pgSQL exception blocks use subtransactions.

- Cluster guards must compare the complete genesis hash, not an abbreviated
  identifier. Verify it against independent RPCs and test rejection of truncated
  values before live provider experiments.

- For Turnkey dashboard guidance, inspect the current UI first. API Keys lives
  on My Profile and the action is labelled New API Key.

- For #52's current local/frontend integration phase, the user explicitly chose
  wildcard CORS (`*`) and Brave with Phantom for browser checks. Keep cookies
  disabled and the configurable origin allowlist available; do not silently
  substitute a stricter default or another wallet.

- For #52, distinguish wrap from larger confidential transfers: fresh wrap fits
  v0 (812 bytes), even though confidential transfer needs v1. Test each flow.
  Phantom must use Testnet Mode / Solana Devnet for devnet previews. Successful
  transaction signing does not prove confidential-key enrollment: the SDK's
  canonical derivation message was rejected separately. Never substitute a new
  message or submit setup with discarded temporary keys just to pass an E2E test.

- Run fresh Supabase migration startup after migration changes. Rust fixtures that
  execute SQL directly bypass the migration-version registry and cannot detect
  duplicate filename timestamps. Fetch main and check its migration versions
  before choosing a new one; keep fixture migration order consistent with it.

- Adding receipt metadata also requires updating the indexer schema allowlist.
  Run its disposable-database test after receipt migrations, and include the
  rejected column in assertion failures so a schema mismatch is easy to trace.

- Private balance reads need the canonical AES key as well as the ElGamal key.
  Store both only as audited Vault ciphertext. An apply credit-counter mismatch
  must block reads instead of presenting a stale AES balance as available funds.

- Backend/web3 work owns proof routes, chain behavior, migrations and API docs.
  Preserve nullable roster amounts and counterparty IDs, and describe those
  values for client owners. Validate signing through isolated devnet protocols
  when the product wallet is unavailable; keep that evidence separate from E2E.

- Retain the original request ID and submission signature through an RPC outage.
  Retry allowlisted reads within one total deadline, preserving commitment and
  minimum context slot. Missing history cannot authorize another payment.
  Diagnostics must exclude provider URLs, messages, parameters, keys and amounts.

- Isolate database roles as well as schemas between storage test suites. Apply
  receipt-view migrations in order, with auditor grants before public fallback,
  so a later view replacement cannot drop transparent metadata. Direct fixture
  connections need the same explicit loopback transport policy as the harness.

- SQL boolean short-circuiting does not skip permission checks while planning an
  expression. Put role-specific protected-table queries in separate PL/pgSQL
  branches rather than granting a role extra access to satisfy a shared OR.
  Run the tenant suite after changing a trigger used by existing service roles.

- An owner creation lock spans proof generation, which can exceed the ordinary
  five-second query timeout on CI or a busy server. Bound only the lock wait by
  the HTTP budget, restore query limits after acquisition, and test a deliberately
  slow owner plus cancelled waiters. Passing on a fast local machine misses this.
