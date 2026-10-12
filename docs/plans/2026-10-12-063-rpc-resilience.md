# Recover temporary RPC read failures

Scope: backend/web3 follow-up to the #63 validation. Frontend schemas, wallet
integration and mocks remain with their owners. Preserve all existing work.

The live configure flow finalized its transaction before confirmation returned
`503 rpc_unavailable`. Background indexing recovered that same receipt. Public
fallback preparation returned 503 before signing; an unchanged retry succeeded.
The original upstream status/code was not retained, so its exact cause is unknown.
Source inspection verifies that the shared RPC client stops after one failed
read and discards that diagnostic information.

Implement at most three attempts for explicitly allowlisted read-only methods.
Retry connection/request/body transport failures, HTTP 408/429/500/502/503/504,
and validated JSON-RPC node-unhealthy (-32005) or minimum-context-slot (-32016)
errors. Keep identical request parameters, commitments, minimum slots and
transaction versions. Use 250ms/500ms backoff and respect numeric Retry-After
when it asks for a longer wait. A nonnumeric Retry-After disables retry. The
existing configured RPC timeout covers all attempts, body reads and waits
together. A response failure cannot renew that budget.

Null results, malformed JSON/envelopes, incorrect IDs, other RPC errors, invalid
account data, and wrong-cluster results still fail closed. Never retry a write
method, submit a transaction, regenerate proofs or signing bytes, or infer
nonexecution from missing history. Durable submitted signatures and unresolved
attempts remain intact if reads exhaust their budget.

Record only an allowlisted method label, attempt, fixed failure category, HTTP
status, recognized RPC error code and whether another read will be attempted.
Never log URLs, credentials, parameters, response bodies, RPC messages/data,
wallets, signatures, keys or amounts. API errors retain their fixed public shape.

Verify in phases of at most five files:

1. Reproduce HTTP throttling and finalized snapshot lag in focused HTTP RPC tests
   against the unchanged client; capture the expected failures.
2. Implement shared read recovery and sanitized diagnostics. Run compiler,
   formatter, Clippy and the targeted retry/health/fallback regressions. Cover
   terminal errors, null receipts, retry exhaustion, total deadlines, cancellation,
   Retry-After and identical payloads. Verify unknown/write methods remain single
   attempt and diagnostics discard provider-controlled strings.
3. Run focused database-backed account/fallback/recovery regressions and fresh
   devnet configure/public-consent protocols. Keep original signatures, actual
   finalized receipts, and all failed attempts. Record protocol results separately
   from product UI E2E, using the requested skel-test verification principles.

The Solana error identities are defined in
[Agave's RPC error source](https://raw.githubusercontent.com/anza-xyz/agave/master/rpc-client-api/src/custom_error.rs).
The pinned [reqwest 0.12.28 timeout](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html#method.timeout)
covers connection through response-body completion; the follow-up preserves one
total call deadline around all retry attempts.

No commit, push, deployment or frontend modification is authorized by this
follow-up. Validation results will be recorded in a new run directory.
