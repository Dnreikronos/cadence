# Cadence web app

Next.js 15 (App Router), TypeScript and pnpm. Tailwind with shadcn/ui, TanStack
Query, zod and sonner. Supabase Auth keeps the session in cookies through
`@supabase/ssr`.

## Run it locally

You need Node 22+, pnpm, and Docker for the local Supabase stack.

```sh
# From the repository root: Postgres, Auth and a mail catcher, with every
# migration in supabase/migrations applied.
pnpm dlx supabase start

# Then the app.
cd frontend
cp .env.example .env.local   # paste the API URL and Publishable key `supabase start` printed
pnpm install
pnpm dev
```

`supabase status` prints the keys again. Sign-in emails land in Mailpit at
http://127.0.0.1:54324, not a real inbox. `supabase db reset` reapplies the
migrations from scratch; `supabase stop` shuts the stack down.

Neither Docker nor Supabase is needed to see the screens: under `pnpm dev`, with the
two `NEXT_PUBLIC_SUPABASE_*` variables unset, the app runs on the mock service and
`/sign-in` offers the [demo viewer](#demo-viewer).

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

CI (`.github/workflows/frontend.yml`) runs these five, with `NEXT_PUBLIC_API_MODE=mock`
for the build. A pre-commit hook (husky and lint-staged) formats and lints staged files.
There is no end-to-end suite on `main` yet.

## Layout

```
src/app/            App Router. (auth)/sign-in, sign-up; auth/confirm; activate; company/, me/, audit/ per role; dev/ tools
src/components/     app/ (signed-in shell), ui/ (shared pieces), landing/
src/lib/            api/ (client, schemas, mocks), queries/, wallet/, auth/, demo/, supabase/, solana/,
                    money.ts, submissions.ts, and a folder per feature: activation, deposit, me, withdraw,
                    runs, people, auditors, audit, receipts
src/middleware.ts   role-based route guard
```

## Screens

Every screen below runs end to end on the mock service. A route's data sources are
routes of [`docs/dev/API_CONTRACT.md`](../docs/dev/API_CONTRACT.md); most of them are
proposals that the real service does not have yet. The shell of an admin or recipient
page also reads the private balance (`GET /company/balance`, `GET /me/balance`), and
`WalletProvider` is mounted by the shell. The issue is the one in
[`docs/plans/2026-10-04-frontend-completion.md`](../docs/plans/2026-10-04-frontend-completion.md).

| Route                                                  | Screen                                                                      | Role      | Data sources                                                                                                                                                                                            | Issue  |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `/`                                                    | Landing page                                                                | public    | none                                                                                                                                                                                                    | PR #99 |
| `/sign-in`, `/sign-up`                                 | Email-code sign-in, company sign-up, the demo panel                         | public    | Supabase Auth (`signInWithOtp`, `verifyOtp`), then `create_company` or `accept_invite`                                                                                                                  | #76    |
| `/auth/confirm`                                        | The page behind the emailed link                                            | public    | Supabase Auth, through a POST to `/auth/confirm/verify`                                                                                                                                                 | #76    |
| `/activate`                                            | Account setup in three steps                                                | recipient | `GET /me/status`, `POST /keys/enroll`, `POST /accounts/configure` and `/confirm`                                                                                                                        | #80    |
| `/company`                                             | Payments home: recent payments, shortcuts to a run and a deposit            | admin     | `GET /company/payments`, `GET /company/auditors`                                                                                                                                                        | #83    |
| `/company/runs/new`                                    | New payroll run                                                             | admin     | people, `GET /company/people/amounts`, `GET /company/balance`, `GET /company/payments`, `GET /company/auditors`, `POST /company/people/:id/invite`, `POST /runs`, the per-payment `confirm` and `retry` | #83    |
| `/company/runs/[id]`                                   | Run progress, retry, check again                                            | admin     | `GET /runs/:id` (polled every 5 s while a payment is open), people for names, the per-payment `confirm` and `retry`                                                                                     | #83    |
| `/company/people`                                      | People: list, add, edit, remove, invite                                     | admin     | people (Supabase `people` table, or in memory in mock mode), `GET /company/people/amounts`, `PUT /company/people/:id/amount`, `POST /company/people/:id/invite`, `GET /company/auditors`                | #81    |
| `/company/deposit`                                     | Receive USDC and make it private                                            | admin     | a chain read of the wallet's plain USDC, `GET /company/balance`, `POST /wrap` and `/confirm`, `POST /accounts/apply-pending` and `/confirm`, `GET /company/auditors`                                    | #82    |
| `/company/receipts`                                    | Payments, printable receipts, CSV                                           | admin     | `GET /company/payments`, `GET /company/export.csv`, `GET /company/auditors`                                                                                                                             | #84    |
| `/company/auditors`                                    | Auditors: list, invite, revoke                                              | admin     | `GET /company/auditors`, `POST /company/auditors`, `POST /company/auditors/:id/revoke`                                                                                                                  | #85    |
| `/me`                                                  | Balance, apply pending, recent payments                                     | recipient | `GET /me/status` (the gate), `GET /me/balance`, `GET /me/payments`, `POST /accounts/apply-pending` and `/confirm`                                                                                       | #86    |
| `/me/history`                                          | Payment history, CSV                                                        | recipient | `GET /me/payments`, `GET /me/export.csv`                                                                                                                                                                | #86    |
| `/me/withdraw`                                         | Withdraw, with the reveal-risk warning                                      | recipient | `GET /me/balance`, `POST /unwrap` and `/unwrap/confirm`                                                                                                                                                 | #87    |
| `/audit`                                               | The company's payments, receipts, CSV                                       | auditor   | `GET /audit/:company_id/payments`, `GET /audit/:company_id/export.csv`                                                                                                                                  | #88    |
| `/audit/access-log`                                    | Who read what                                                               | auditor   | `GET /audit/access-log`                                                                                                                                                                                 | #88    |
| `/dev/api`, `/dev/components`, `/dev/screens/[screen]` | API playground, component showcase, three company screens without a session | none      | mock only; not found on mainnet                                                                                                                                                                         | n/a    |

Nothing calls `GET /health`, and `POST /transfer` has no screen: payroll goes through
`/runs`. The filters on the receipts and auditor screens narrow only the pages already
loaded, because no route has filter parameters.

## API client and mocks

`src/lib/api/` is the typed client for the proof service, written against
[`docs/dev/API_CONTRACT.md`](../docs/dev/API_CONTRACT.md). Requests and responses
go through zod schemas, so a float amount never leaves the browser and a response
that drifts from the contract fails loudly.

```ts
import { api, signAndConfirm, messageFor } from "@/lib/api"

const prepared = await api.wrap.prepare({
  company_wallet,
  amount: "2500000000",
})
const receipt = await signAndConfirm(prepared, {
  signer, // the user's wallet
  submit, // sends the signed bytes to Solana, returns the signature
  confirm: (signature) =>
    api.wrap.confirm({ request_id: prepared.request_id, signature }),
})
```

Amounts are integer base-unit strings (`"1000000"` is 1 USDC). Errors are
`ApiError` with a stable `code`, the HTTP `status`, a `retryAfter` and an
`isRetryable` flag (`transaction_not_finalized`, any 429, 502 to 504 and a dropped
connection); `messageFor(error)` gives the copy to show. A 429 whose `Retry-After`
cannot be read, which is every cross-origin one until the backend exposes the header,
waits 60 s. A response that does not match its schema is a `ContractError`.

Every request body is checked by a strict schema before it is sent (an unknown field
or a malformed amount, key, signature or `aes_key` throws in the browser), and every
request goes out with `cache: "no-store"`. `signAndConfirm` fails with
`UnexpectedSignerError` if the service asks for a signature from a key that is not the
signer's, and polls confirm for up to 60 s, with `onSubmitted` to keep the signature
if the page is left. The conventions are in the contract; the rule for what a screen
does after a transaction may have been sent is
[below](#when-a-transaction-may-have-been-sent).

`NEXT_PUBLIC_API_MODE` picks the service. `mock` answers from an in-browser
[MSW](https://mswjs.io) handler for every route, including the failures that
change a screen, and shows a MOCK DATA badge next to the DEVNET one; `real` calls
`NEXT_PUBLIC_PROOF_API_URL`, which must be https unless it is localhost, since
the token and the confidential keys travel in the requests. `next dev` defaults
to `mock`. In every other environment (build, preview, production) the variable
must be set, so a deploy that forgets it fails instead of running on fake data.
Mock mode is refused on mainnet. `/dev/api` runs the flows and the switches.

The mock answers only on its own origin (`http://mock.cadence.test`), so it never
shadows a Next route. In the browser, `window.cadenceMock` controls it:

- `set("slow", "partial-failure")`, `clear()` and `active()` flip the failure
  scenarios, and `scenarios` lists them: `instant`, `slow`, `unauthenticated`,
  `rate-limited`, `service-down`, `setup-required`, `tx-failed`, `partial-failure`,
  `credit-mismatch` and `rpc-down` (the chain read behind the public USDC balance).
  `?mock=slow,partial-failure` in the page URL turns scenarios on, and is read once,
  when the worker starts (at the first API call).
- `setRole("admin" | "recipient" | "auditor" | null)` makes routes enforce a role
  and answer 403 `forbidden_role` otherwise. The default `null` is permissive.
- `reset()` restores the seed data (balances, payments, runs, people, auditors, the
  access log). `resetAccountStatus()` only makes the recipient one who has done none of
  the activation steps. The mock lives in the page, so a reload resets everything.

The mock is not the real service: its CSV, a few error codes, its paging and its
roles differ. Those are listed in the contract under
[Mock deviations](../docs/dev/API_CONTRACT.md#mock-deviations), and nothing should be
built on them.

`public/mockServiceWorker.js` is generated by MSW. After upgrading `msw`, refresh
it with `pnpm dlx msw init public/ --no-save` and commit the result.

## Demo viewer

With `NEXT_PUBLIC_API_MODE=mock` and Supabase not configured, `/sign-in` offers "Try
the demo" as company admin, recipient or auditor (`ana@solaris.test`,
`bruno@solaris.test`, `carla@acme-audit.test`, company Solaris), and as a new
recipient who has done no activation step (it opens `/activate?fresh=1`). It sets the
httpOnly `cadence-demo-role` session cookie (`secure` only over https), which the
middleware and `currentViewer()` trust only in that exact configuration
(`src/lib/demo/allowed.ts`): never with Supabase configured, in real mode or on
mainnet. The demo is inferred from that configuration, with the explicit `mock` mode
as the opt-in, so a typo in a Supabase variable also turns it on: check the env before
sharing a deploy. Sign-out clears the cookie. A reload resets the mock data.

The company people list follows the API mode, not whether Supabase is configured
(`src/lib/people/repository.ts`): in mock mode the people are an in-memory list with
the mock service's ids, even with Supabase configured, because the amounts and invites
go to the mock service, which only knows those ids; in real mode they are the Supabase
`people` rows, and real mode without Supabase shows "Sign-in is not configured".

## Wallet

Screens sign through `useWallet()` (`src/lib/wallet`): `{ status, address, signer,
submit }`, plus `loading` while the mock wallet loads and a `reason` when it is
unavailable. The signed-in shell mounts `WalletProvider` with the viewer's role. Mock
mode gives the admin and recipient a mock wallet and the auditor none; those mocks are
imported dynamically, so a real-mode build has none of them. Real mode is
`unavailable` and throws naming #78 and #80, until they land, so in real mode nothing
can be signed yet. The `Signer` has `signTransaction` and an optional `signMessage`
(used only for the key-derivation message). `useSignAndConfirm()` gives
`await run(prepared, confirm, onStep, extra)`, where `extra` takes `signal` and
`onSubmitted`.

## Money and queries

`src/lib/money.ts` converts between base-unit strings and dollars (`unitsToUsd`,
`usdToUnits`, `formatUnits`, `formatBaseUnits`, `sumUnits`); parsing is strict and
never rounds, and `formatUnits` rounds to cents for display only (`formatBaseUnits` is
exact). Amounts live in React Query's memory cache only.
Server state goes through React Query: the one `QueryClient` and its defaults live
in `src/lib/queries/client.ts` (30 s stale time, one retry except for a 4xx
`ApiError`, no refetch on focus), and every key comes from `queryKeys` in
`src/lib/queries/keys.ts`. The sidebar balance is `useShellBalance(role, viewer)`,
cached per viewer and cleared on sign-out and when a sign-in page mounts (clearing also
empties the mutation cache). A mutation that moves money must call
`invalidateBalances(queryClient)` so the sidebar updates. Two things poll: the run
screen reads `GET /runs/:id` every 5 s while a payment is open, and `/me` reads the
balance every 3 s for up to 30 s after a confirmed apply.

### When a transaction may have been sent

From the moment signing hands over to submitting, a transaction may be on the network,
even if the send throws. After that a screen never prepares a replacement: it
re-confirms with the saved signature, or tells the person to check their balances. The
exception is `transaction_failed`, which means the network refused it. Deposit,
withdraw, apply-pending, payroll payments and the activation account step all follow
this. The evidence is kept unevenly:

- `src/lib/submissions.ts` keeps one record per kind of flow in `sessionStorage`
  (`request_id`, signature, block height, wallet, time; nothing secret). **Deposit (the
  wrap step) and apply-pending use it**, so a reload finds out what became of the
  transaction before anything else is sent.
- **Withdraw and payroll do not use it yet.** Withdraw holds the amounts in memory
  (the mutation cache) and payroll holds signatures in component state, so a reload, or
  for withdraw a sign-out, forgets a transaction that may have landed. A payroll
  payment also can only be signed in the session that created its run. Persisting
  both is a prerequisite for real signing.

The details, and the table of flows, are in the contract under
[The sent-failure rule](../docs/dev/API_CONTRACT.md#the-sent-failure-rule).

## Activation

`/activate` (recipient) is one progress screen: create the wallet, sign the
key-derivation message and `api.keys.enroll` it (`key_already_enrolled` counts as done
only if `api.me.status()` then reports the key as enrolled; otherwise the screen says
the wallet was set up elsewhere), then `api.accounts.configure` and sign it. The steps
are the three flags `wallet_linked`, `key_enrolled` and `account_configured` of
`api.me.status()` (`pending_credits` is not read), so it resumes where it stopped, and
"Try again" re-reads the status and runs only what is not done. A configure that
reached the network is settled on the next try, never prepared twice. `/me` shows its content only once the status is
complete and sends the rest to `/activate`. The key-derivation signature is
secret: it lives in one local variable for the enroll call, never in state, a
mutation, a log, a URL or an error. Wallet creation in real mode waits for #78; the
screen says so. The message that is signed is a mock placeholder
(`src/lib/activation/message.ts`) and building it throws outside mock mode, until #80
provides the canonical one. Code: `src/lib/activation/` (state machine, steps) and
`src/lib/queries/activation.ts`.

## Route guard

`src/middleware.ts` refreshes the Supabase session on every request and guards
three areas by the viewer's role (in the demo configuration above there is no
Supabase session: the demo cookie is the session). A user holds at most one membership, so one
role:

| Path         | Role        |
| ------------ | ----------- |
| `/company/*` | `admin`     |
| `/me/*`      | `recipient` |
| `/activate`  | `recipient` |
| `/audit/*`   | `auditor`   |

Every session belongs to a company: the middleware signs out a session that has
no membership (for example, after a removal), on this device only
(`scope: "local"`), and sends it to `/sign-in?error=no_company`. A signed-out
visit goes to `/sign-in?next=<path and query>`, and a member with another role
goes to their own area. If Supabase is unreachable or unconfigured, or the
membership lookup fails, guarded areas are treated as signed out (nobody is
signed out over a failed lookup). The rules live in `src/lib/auth/guard.ts`.

Row-level security is still the authorization boundary for the tables the browser
reads, and the proof service's own role checks are for its routes: the middleware only
decides which page to show. `/dev/*` is not guarded by role; it answers not found on
mainnet.

## Sign-in and sign-up

There are no passwords. Each email carries a 6-digit code and a link, from the
templates in `supabase/templates/`. The code is entered on the form. The link
lands on `/auth/confirm`, which only shows a "Continue" button: the token is
spent by that button's POST to `/auth/confirm/verify` (same-origin only), so a
mail scanner that opens the link does not use it up, and it works in any
browser. Both paths end in `completeSignIn` (`src/lib/auth/complete-sign-in.ts`).
The confirm page sets `Referrer-Policy: same-origin`, not `no-referrer`: Chrome
sends `Origin: null` with a form POST under the latter, which the verify route
refuses.

Accounts exist only to belong to a company, and there are two ways to get one:

- **Admin**: `/sign-up` asks for the company name and an email. Confirming the
  email creates the company (`create_company`) and lands on `/company`.
- **Recipient or auditor**: an invite link, `/sign-in?invite=<token>`.
  Confirming the email accepts the invite (`accept_invite`) and lands on the
  area for the role.

`/sign-in` without an invite never creates an account, and it never reveals
whether an email has one: an unknown email gets the same "code sent" step (no
mail goes out, so any code fails with the generic message). "No company on this
email" is shown only after a valid code from an account that has no membership.
If a confirmation ends without a membership (an expired invite, for instance),
the session is signed out again and the form shows why (`?error=<code>`, mapped
in `src/lib/auth/sign-in-errors.ts`). A member who opens an invite is not
dropped: they land on a page saying they already belong to a company, with a
sign-out that returns to the invite. A failed membership lookup shows the form
with a retry message, never a 500.

Supabase rate-limits a repeat request per address only for addresses that have
an account (a 429 `over_email_send_rate_limit`, where an unknown address still
answers `otp_disabled`), so that 429 is shown as the same code step too: only the
per-IP `over_request_rate_limit` says "too many attempts".

Known and accepted limits of this design:

- **Login CSRF through someone else's emailed link.** The confirm page cannot say
  whose account the link signs into (the token is not read until the POST), so a
  person who is handed an attacker's own valid link and presses Continue is signed
  into the attacker's account. The origin check stops other sites posting for them,
  not this.
- **Enumeration timing.** An unknown address answers a little faster than one that
  is mailed. Supabase's own rate limits are the control; nothing here tries to equalise it.

The Sign out menu item ends this device's session only; "Sign out of all devices"
(`signOutEverywhere`) ends them all. Both clear the `sb-*` cookies even if Supabase
cannot be reached. Every response carries `frame-ancestors 'none'` and
`X-Frame-Options: DENY` (`src/lib/security-headers.ts`); the confirm page and the
verify route are `no-store`. Guarded routes must never carry a secret in their
query string: it goes into `?next=` (minus Next's own `_rsc` and `__next*`).

The invite token and company name ride through sign-in as form fields and
inside the emailed link, so they survive opening the email on another device.
The link is built from `{{ .RedirectTo }}`. Every deployed origin must therefore
be listed under the Supabase Auth redirect URLs (`additional_redirect_urls`
locally) as `<origin>/**`.

## Solana

Use `@solana/kit` only. Do not add `@solana/web3.js` 1.x or
`@solana/wallet-adapter-*`: both call `serialize()`, which throws on the v1
transactions a confidential transfer needs.

Get an RPC client from `createRpc()` in `src/lib/solana/rpc.ts`. Its transport
sets `maxSupportedTransactionVersion: 1` on every call that can return a
transaction, overriding whatever the caller passed.

`NEXT_PUBLIC_SOLANA_CLUSTER` selects `devnet` (local and previews) or `mainnet`
(production). Anything but mainnet shows a DEVNET badge. `NEXT_PUBLIC_SOLANA_RPC_URL`
optionally replaces the cluster's public RPC. The Deposit screen reads the company
wallet's plain USDC from the chain (its associated token account, the one a wrap
debits) with `src/lib/solana/balances.ts`; mock mode answers that read from the mock.

## Deploys

Vercel builds this directory (project root directory `frontend/`), with a
preview for every pull request. Set the variables from `.env.example` per
environment: Production gets `mainnet`, Preview and Development get `devnet`.

`NEXT_PUBLIC_API_MODE` must be set outside `next dev`, or the build fails. A Preview
can run `mock` (with the Supabase variables unset, the demo viewer is on). Production must
be `real` with `NEXT_PUBLIC_PROOF_API_URL` set to an https URL, because mock mode is
refused on mainnet. Most routes the screens call do not exist on the proof service
yet, and in real mode nothing can be signed until #78 and #80, so a `real` deploy does
not work end to end today.
