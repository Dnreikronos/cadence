# Finish the frontend, against mocks

Date: 2026-10-04. Covers #76, #78 to #88 and the gaps between them. Backend and Turnkey
integration come after this and are out of scope here.

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
2. **Wallet provider.** `useWallet()` returns `{ signer, submit, address, status }`. Mock
   mode: the mock signer for the demo role's wallet and a fake submit. Real mode: a
   placeholder that throws until #78/#80.
3. **Shell data.** The shell's private balance and the company name come from the viewer
   and a client-side query, not constants.
4. **Receipts** are built from payment items (amount, counterparty, dates, signature);
   no new route.
5. **Route additions** the screens need, added to the client, the mocks and the contract
   as 🟡 proposals: `GET/POST/DELETE /company/auditors`, `GET /audit/access-log`,
   `GET /me/status`. They follow the same conventions as the existing ones.

## Tasks

| #   | Task                                                                  | Issue         | Routes                                                | Depends on |
| --- | --------------------------------------------------------------------- | ------------- | ----------------------------------------------------- | ---------- |
| F1  | Foundation: demo viewer, wallet provider, money helpers, shell wiring | #76           | `/sign-in`, shell                                     | none       |
| F2  | Client and mock additions: auditors, access log, status               | #59, #88, #80 | none                                                  | none       |
| A   | Company people and invites on the client                              | #81           | `/company/people`                                     | F1         |
| B   | Company deposit on the client                                         | #82           | `/company/deposit`                                    | F1         |
| C   | Payroll runs: new run, progress, retry, payments home                 | #83           | `/company`, `/company/runs/new`, `/company/runs/[id]` | F1         |
| D   | Company history, receipts and export                                  | #84           | `/company/receipts`                                   | F1         |
| E   | Auditors on the client (João's #112, then migrated)                   | #85           | `/company/auditors`                                   | F2, #112   |
| G   | Activation: wallet, key enrollment, account setup                     | #80           | `/activate`                                           | F1, F2     |
| H   | Recipient: balance, history, receipts                                 | #86           | `/me`, `/me/history`                                  | F1         |
| I   | Recipient: withdraw with the reveal-risk warning                      | #87           | `/me/withdraw`                                        | F1         |
| J   | Auditor panel and access log                                          | #88           | `/audit`, `/audit/access-log`                         | F1, F2     |
| K   | Sign-in completion: invite acceptance, sign-out, empty states         | #76           | `(auth)`, `/auth/confirm`                             | F1         |
| Q   | End-to-end tests, accessibility and design pass, docs                 | all           | none                                                  | A to K     |

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
