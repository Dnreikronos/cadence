# Finish the frontend, against mocks

Date: 2026-10-04. Covers #76, #78 to #88 and the gaps between them. Backend and Turnkey
integration come after this and are out of scope here.

**Status (2026-10-04, synced with `main`): complete except Q.** Every task below except
Q is merged; Q (#126) is open, and `frontend/e2e` is not on `main`. The plan itself was
#113 and the embedded-wallet spike it leans on was #111. Sections below the task table
record what changed from the plan, what has to happen before real signing, and what is
known to be missing.

## Goal

Every screen the product needs exists, works end to end in **mock mode** (the typed
client from #110 answering from MSW), is reachable without Supabase through a demo
viewer, and has loading, empty, error and validation states, a layout that works at
390 px, and tests. When the backend routes exist, the work left is swapping the mock for
the real service and wiring Turnkey; no screen is redone.

## Ground rules

- **Mock mode only.** Screens call `@/lib/api` through React Query hooks in
  `src/lib/queries/`. No screen keeps a private in-memory mock. People and auditors
  are Supabase tables in production (RLS) but not proof-service routes; they go through
  a repository interface with a Supabase implementation and a mock implementation.
- **No backend or Turnkey calls.** Wallet signing goes through `useWallet()`; mock mode
  returns the mock signer. The real Turnkey implementation is #78/#80's integration work
  and is gated on the security decisions in
  `docs/dev/spikes/2026-10-03-embedded-wallet.md`.
- **Money-moving mutations refresh the shell.** Every mutation that moves money
  (deposit, payment, withdrawal, retry) calls `invalidateBalances(queryClient)` from
  `src/lib/queries/invalidate.ts` on success; the sidebar balance does not refetch on
  its own.
- **Amounts** are integer base-unit strings in the client and are converted for display
  with `src/lib/money.ts`. No float math on money.
- **Copy is honest about privacy**: Cadence can read amounts (ADR B17); deposits and
  withdrawals are public; payments are encrypted on-chain. Use `WhoCanSee` and the
  reveal-risk flag, never "nobody can see this".
- **One PR per screen**, from `main`, small enough to review: typecheck, lint, format,
  tests and `pnpm build` pass; screenshots in the PR body at desktop and 390 px; states
  exercised in a browser. Each PR gets an independent review (code, accessibility,
  security) and a QA pass before it merges.
- **Do not touch** `src/app/dev/screens/[screen]/page.tsx` (the demo viewer makes the
  real routes reachable), and keep edits to shared files (`nav.ts`, `app-shell.tsx`,
  `lib/api/mocks/*`, `lib/api/schemas.ts`) minimal and additive, to avoid merge
  conflicts between parallel PRs.

## Architecture decisions

1. **Demo viewer.** In mock mode with Supabase not configured, `/sign-in` offers "Try
   the demo as company admin, recipient or auditor". It sets a cookie; the middleware and
   `currentViewer()` trust it **only** in that configuration (never on mainnet, which
   already refuses mock mode). This is what makes Preview deploys, and QA, work without
   a backend.
2. **Wallet provider.** `useWallet()` returns `{ signer, submit, address, status }`
   (plus `loading` while the mock wallet loads, and a `reason` when unavailable). Mock
   mode: the mock signer for the demo role's wallet and a fake submit; an auditor has
   no wallet. Real mode: an `unavailable` wallet whose signer and `submit` throw until
   #78/#80, so a missed check fails loudly.
3. **Shell data.** The shell's private balance and the company name come from the viewer
   and a client-side query, not constants.
4. **Receipts** are built from payment items (amount, counterparty, dates, signature);
   no new route. They are printed from the browser's print dialog (save as PDF).
5. **Route additions** the screens need, added to the client, the mocks and the contract
   as 🟡 proposals: `GET` and `POST /company/auditors`, `POST /company/auditors/:id/revoke`
   (a `POST`, not the `DELETE` this plan first wrote, because the service's CORS allows
   only GET and POST), `GET /audit/access-log` and `GET /me/status`. They follow the
   same conventions as the existing ones.

## Tasks

The last column is what each task became on `main`. Review and QA passes were done per
PR and are recorded there, not repeated here.

| #   | Task                                                                  | Issue         | Routes                                                | Depends on | PR                        | Outcome                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------- | ------------- | ----------------------------------------------------- | ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Foundation: demo viewer, wallet provider, money helpers, shell wiring | #76           | `/sign-in`, shell                                     | none       | #115, merged              | Demo viewer with a session cookie, `WalletProvider` and `useWallet()`, `money.ts`, shell balance and company name from the viewer. Real mode has no wallet.                                                                                                 |
| F2  | Client and mock additions: auditors, access log, status               | #59, #88, #80 | none                                                  | none       | #114, merged              | Client, schemas and mock for the auditor routes, `GET /audit/access-log`, `GET /me/status` and the `rate_limited` code. Revoke is `POST /company/auditors/:id/revoke`.                                                                                      |
| A   | Company people and invites on the client                              | #81           | `/company/people`                                     | F1         | #123, merged              | People list, add, edit and remove through a repository (Supabase in real mode, in memory in mock mode), amounts through the proof service, invites and re-invites.                                                                                          |
| B   | Company deposit on the client                                         | #82           | `/company/deposit`                                    | F1         | #121, merged              | Wrap then apply-pending, public USDC read from the chain, a persisted record of the wrap and a check of it before another can be sent. No company wallet setup: `confidential_setup_required` is a dead end.                                                |
| C   | Payroll runs: new run, progress, retry, payments home                 | #83           | `/company`, `/company/runs/new`, `/company/runs/[id]` | F1         | #124, merged              | Payments home, new run (100-person cap, one idempotency key per attempt, 24-hour repay guard), one-at-a-time signing, per-payment retry and "Check again", status by polling `GET /runs/:id`. Nothing is persisted for a reload.                            |
| D   | Company history, receipts and export                                  | #84           | `/company/receipts`                                   | F1         | #119, merged              | Paged payments with filters over the loaded pages, a printable receipt built from the payment item, CSV export.                                                                                                                                             |
| E   | Auditors on the client (João's #112, then migrated)                   | #85           | `/company/auditors`                                   | F2, #112   | #118, merged (after #112) | The auditors screen moved onto the typed client: list, invite, revoke, with the conflicts and stale-list handling.                                                                                                                                          |
| G   | Activation: wallet, key enrollment, account setup                     | #80           | `/activate`                                           | F1, F2     | #120, merged              | Three steps driven by `GET /me/status`: wallet, key, account. In mock mode it runs end to end. In real mode wallet creation says it is unavailable, and the key-derivation message is a mock placeholder that throws.                                       |
| H   | Recipient: balance, history, receipts                                 | #86           | `/me`, `/me/history`                                  | F1         | #125, merged              | Activation gate, balance card with apply-pending (lock, check, no retry after a possible send), recent payments, history with CSV export.                                                                                                                   |
| I   | Recipient: withdraw with the reveal-risk warning                      | #87           | `/me/withdraw`                                        | F1         | #116, merged              | Withdraw with the acknowledgement step, risk levels, and held amounts after a possible send. The held amounts are in memory only.                                                                                                                           |
| J   | Auditor panel and access log                                          | #88           | `/audit`, `/audit/access-log`                         | F1, F2     | #117, merged              | Company payments with client-side filters, receipts and CSV export; the paged access log.                                                                                                                                                                   |
| K   | Sign-in completion: invite acceptance, sign-out, empty states         | #76           | `(auth)`, `/auth/confirm`                             | F1         | #122, merged              | Emailed link opens a confirm page that spends the token only on a POST, invite acceptance, sign-out of this device and of all devices, `frame-ancestors 'none'` and no-store headers, and the sign-in that does not reveal whether an email has an account. |
| Q   | End-to-end tests, accessibility and design pass, docs                 | all           | none                                                  | A to K     | #126, **open**            | Not merged. `frontend/e2e` is not on `main`, so no end-to-end test exists there yet and none is documented. The docs part is this sync of the contract, this plan, `docs/README.md` and `frontend/README.md`.                                               |

Parallelism: F1 and F2 first, in parallel. Then A to K in parallel in separate
worktrees; merge in the order they are green, rebasing the rest. Q last.

## Not in scope

The real Turnkey login and wallet route (#78) and the real Turnkey signer (#80's
wallet step), which wait on the decisions in the embedded wallet spike; the real
Supabase-backed hosted project (#100); the proof-service routes (#55 onward); anything
that needs a deployed backend.

## Decisions made while planning

- #78 stays out: its route needs Turnkey credentials in the hosting platform and the
  security decisions (passkey as root, parent-key scope), which are the team's.
- #85 is João's. His PR is reviewed and merged as is; the migration to the client
  happens in task E so the screen does not diverge.
- A demo viewer is added rather than requiring a hosted Supabase for every Preview.

## What changed from the plan

- **The demo is inferred from the configuration.** The plan said the demo viewer
  appears in mock mode with Supabase not configured, and this is what was built: no
  separate switch, so the demo is on whenever `NEXT_PUBLIC_API_MODE=mock`, Supabase is
  not configured and the cluster is not mainnet (`src/lib/demo/allowed.ts`). The
  explicit opt-in is the mock mode. A typo in a Supabase variable therefore turns the
  demo on, so check a deploy's environment before sharing it. The cookie is a session
  cookie (`cadence-demo-role`, httpOnly, `secure` only over https). A "New recipient"
  choice on the demo panel opens `/activate?fresh=1` to replay activation.
- **The people repository is chosen by the API mode.** Not by whether Supabase is
  configured: amounts and invites go to the same service as everything else, and the
  mock service only knows the mock people. In mock mode the people are in memory even
  with Supabase configured; in real mode they are the Supabase rows, and real mode
  without Supabase shows "Sign-in is not configured".
- **A generic submissions helper.** `src/lib/submissions.ts` keeps one record per kind of
  flow in `sessionStorage` (`request_id`, signature, block height, wallet, time). It was
  written for the deposit's wrap and reused by apply-pending. It is not used by
  withdraw or payroll yet (see the checklist below).
- **A 100-recipient cap on a run.** A run request takes 1 to 100 payments: each entry
  is about 80 bytes and the service takes 8 KiB bodies. The client schema enforces it
  and the new-run screen blocks above it. The plan had no limit.
- **The sent-failure rule.** After a transaction may have been broadcast, a screen never
  prepares a replacement; it re-confirms the saved signature, or tells the person to
  check balances. It was added through the review rounds of withdraw, payroll, deposit
  and apply-pending, and the activation screen's account step follows it too. The
  contract states it in [The sent-failure rule](../dev/API_CONTRACT.md#the-sent-failure-rule).
- **Revoking an auditor is a `POST`.** `POST /company/auditors/:id/revoke`, because the
  service's CORS allows only GET and POST. The plan wrote `DELETE`.
- **Run status is polled.** The new-run and run screens read `GET /runs/:id` every 5 s
  while a payment is open. The contract's first draft said Supabase Realtime, which the
  web app does not use.
- **A run's payments can only be signed in the session that created it**, because only the
  `POST /runs` answer carries the transactions. A reload leaves unsigned payments
  `pending` and the run screen says to start a new run for them.
- **A 24-hour repay guard.** The new-run screen leaves unticked anyone with a confirmed
  payment in the last 24 hours, reading the company's payments to know.

## Before real signing

Nothing below is done. Real signing means the Turnkey wallet signs, the app sends the
transaction to Solana and the real service confirms it; today every screen runs on the
mock signer and a fake submit, and in real mode `useWallet()` is unavailable.

- [ ] Persist submissions for withdraw and for payroll with `src/lib/submissions.ts`, and
      check them on return as deposit and apply-pending do. Today a reload forgets a
      withdrawal or a run payment that may have landed, and signing out clears the
      held withdrawal amounts.
- [ ] Get the canonical key-derivation message from the SDK (and the token account it is
      for). `keyDerivationMessage` in `src/lib/activation/message.ts` is a mock
      placeholder that throws outside mock mode. Real `signMessage` must refuse any
      other bytes.
- [ ] Decide the Turnkey questions in the embedded-wallet spike's Security review
      (#78, #80): passkey or OAuth as the root user, step-up for new keys and large
      transfers, session length, recovery and export, splitting the parent key from the
      Supabase service role, email OTP as the root of trust, and how product copy states
      custody. See
      [the spike](../dev/spikes/2026-10-03-embedded-wallet.md#decisions-for-the-team).
- [ ] Replace the real-mode placeholder wallet with the Turnkey signer and a `submit`
      that sends the signed bytes to Solana, and test a real v1 transaction from a user
      session on devnet (the spike did not).
- [ ] Build the company wallet setup screen: the Deposit screen sends no `setup`, and
      `confidential_setup_required` ends with no link.
- [ ] Put an RS256 signing key on the hosted Supabase project (#100); the spike's
      verdict is conditional on it and it has not been tried.
- [ ] Set `NEXT_PUBLIC_API_MODE=real` and `NEXT_PUBLIC_PROOF_API_URL` (https) on Vercel
      Production. The build refuses to guess, and mock mode is refused on mainnet.
- [ ] Get answers to the [open questions](../dev/API_CONTRACT.md#open-questions),
      especially 26 to 35 and the CORS requests (`PUT`, `Retry-After`), or change the
      screens to match what the backend decides.

## Known gaps

- **Company wallet setup for admins.** No screen configures a company wallet. A
  deposit to an unconfigured wallet fails with `confidential_setup_required` and a
  message that says the step "isn't available from this screen yet".
- **Filters are client-side.** No route has filter parameters, so the receipts and the
  auditor payments filters narrow only the pages already loaded; "Load more" can
  bring in more matches.
- **The mock's CSV is not the contract's format.** It writes `4200`, not `4200.000000`,
  and ends lines with `\n`, not CRLF. The other
  [mock deviations](../dev/API_CONTRACT.md#mock-deviations) apply too, and
  `transaction_mismatch` is never produced by the mock.
- **Hosted Supabase (#100) is untested.** Nothing was run against a hosted project,
  and no RS256 key is set on one.
- **The real-Supabase repository paths are covered by unit tests with fakes** and by the
  auth task against a local Supabase stack. They were not run against a hosted project
  or against the real proof service.
- **A reload loses what a payroll run or a withdrawal was doing.** Signatures of sent
  run payments and held withdrawal amounts are in memory; unsigned run payments cannot
  be signed after a reload.
- **Unknown payment and run statuses fail the response.** Those schemas are strict, unlike
  the reveal-risk level, the auditor status and the access-log enums.
- **No service-status banner.** `api.health()` exists and no screen calls it.
- **`/transfer` has no screen.** Payroll goes through `/runs`, so the client's `/transfer`
  and the `aes_key` it needs are never used.
- **End-to-end tests are not on `main`.** Q (#126) is open.
- **This sync was done by reading the code on `main`**, not by running the screens in a
  browser. The tests, reviews and browser checks of each task are in that task's PR.
