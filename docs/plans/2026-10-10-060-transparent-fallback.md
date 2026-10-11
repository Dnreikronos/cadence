# Issue #60: transparent transfer fallback

When the ZK ElGamal proof program is unavailable, prepare ordinary checked
Token-2022 transfers for the same wrapped USDC mint and token accounts. Apply
this to standalone transfers, payroll preparation, and eligible payroll retries.
Keep the existing authenticated wallet ownership, unsigned v1 transactions,
confirmation matching, finalized receipts, and retry protections.

Read the executable proof-program account and the disable and re-enable feature
accounts at startup when payment services are configured, and again for each
preparation. An active re-enable gate overrides the disable gate. RPC failures
or malformed feature accounts must fail with a sanitized RPC error; they must
not silently change the privacy mode. Do not cache startup availability.

Fallback spends the sender's public wrapped-token balance. It cannot withdraw
encrypted funds without the disabled proof program. Validate initialized,
unfrozen accounts, mint and sender ownership, destination public-credit policy,
and available public funds. For a run, reserve public funds only for payments
successfully prepared, in signing order. Return a stable funding error when the
public reserve is insufficient. Do not load Vault keys or allocate proof contexts
for fallback.

Persist `transparent` with each prepared payment and standalone receipt. Preserve
it through confirmation, indexing, and archived retry attempts; permit a new
attempt to select the current mode. Return it in payment APIs and load it in the
run signing and progress UI so the transparent badge becomes accurate.
Audit reads must decode ordinary checked transfers without decrypting a key.
Plaintext amounts remain confined to the public transaction and authorized
receipt response, rather than a separate database amount column.

Verify feature-gate combinations and malformed/unavailable RPC responses; public
transfer instruction contents, ownership, frozen accounts, destination policy,
balance exhaustion, and sequential allocation; an HTTP payroll run completing
with the proof program simulated unavailable; mode changes on safe retries;
immutable stored mode and archived attempts; and the frontend signing checks and badge
metadata. Run Rust formatting, compiler and Clippy, targeted Rust tests, frontend
typecheck/lint and targeted signing tests. Use disposable local databases only.

The user also requested a public-balance funding flow. Extend `POST /wrap` with
an explicit `mode: "public"` (omitted mode stays confidential). Public funding
creates the wrapped Token-2022 ATA when needed, enables public credits on an
existing confidential account when necessary, and wraps USDC without confidential
setup, deposit, apply-pending, or proof instructions. Return
`deposit_state: "public_after_confirmation"`; confirmation keeps the existing
exact-message and finalized-receipt checks.

Offer private funding and public payment-reserve funding in the company deposit
form, with clear public-amount disclosure and a visible reserve balance. Both
modes share the existing controller and persistent submission lock. Preserve the
funding mode across retries and reloads, and stop public funding after its one
transaction confirms. Verify missing/existing destinations, validation, signed
HTTP confirmation, public-only controller behavior, uncertain submissions and
mode-aware recovery, plus frontend compiler/lint and targeted tests.

Verification on 2026-10-11 uses a fresh branch from main, including its pre-sign
transaction decoder, shared submission records and finalized block-height checks.
Public payments are checked against the approved recipient and amount, and public
funding is refused if the service returns a confidential deposit instead.

Rust formatting, all-target compilation and Clippy passed. Targeted tests cover
proof availability and public builders, a simulated outage completing payroll and
a standalone payment, retained retry privacy, auditor reads without viewing keys,
and public wrapping for new and existing accounts. Database tests use disposable
local containers and simulated finalized receipts.

Frontend compilation and targeted ESLint passed. Targeted tests cover both public
transaction shapes, payroll signing, deposit execution and recovery, public reserve
reads, mocks and submission persistence. The production demo build passed.
Browser scenarios cover both funding choices and an unknown public deposit after
reload. No live payments were sent and no deployed schema was changed.
