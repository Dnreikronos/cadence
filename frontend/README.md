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

`pnpm build` is a production build, so it needs `NEXT_PUBLIC_API_MODE` and
`NEXT_PUBLIC_SOLANA_CLUSTER` set (`.env.local` is read; a bare shell is not enough):
`NEXT_PUBLIC_API_MODE=mock NEXT_PUBLIC_SOLANA_CLUSTER=devnet pnpm build`.

CI (`.github/workflows/frontend.yml`) runs these five, with those two variables for the
build, then a non-blocking `pnpm audit --prod --audit-level=high` (it prints advisories and
never fails the job; Dependabot, `.github/dependabot.yml`, opens the updates). The
end-to-end suite is a separate job, [below](#end-to-end-tests). A pre-commit hook (husky
and lint-staged) formats and lints staged files. Third-party actions in the workflows are
pinned by commit SHA, with the tag in a trailing comment.

## Layout

```
src/app/            App Router. (auth)/sign-in, sign-up; auth/confirm; activate; company/, me/, audit/ per role; dev/ tools
src/components/     app/ (signed-in shell), ui/ (shared pieces), landing/
src/lib/            api/ (client, schemas, mocks), queries/, wallet/, auth/, demo/, supabase/, solana/,
                    money.ts, submissions.ts, and a folder per feature: activation, deposit, me, withdraw,
                    runs, people, auditors, audit, receipts
src/middleware.ts   role-based route guard
e2e/                Playwright tests (specs) and e2e/support/ (helpers)
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

The run screens use the `/runs` shape the contract proposed (people, an idempotency
key, per-payment confirm and retry). The backend has since implemented `/runs` in a
different shape (`docs/dev/RUNS_API.md`), so they work on the mock only until the
client is reconciled; see
[Payroll run](../docs/dev/API_CONTRACT.md#payroll-run-one-approval-many-recipients-).

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

The `/dev/*` pages (component showcase, screen previews, `/dev/api`) show fake data and
need no session, so they are served by `next dev` and answer 404 in a production build
(every deploy) unless `NEXT_PUBLIC_DEV_TOOLS=1` is set at build time, and always on
mainnet. They may frame each other (`frame-ancestors 'self'`); every other path still
refuses framing.

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
it with `pnpm dlx msw init public/ --no-save` and commit the result. It is a static file,
so every build serves it, production included. It does nothing until a page registers it,
and only `NEXT_PUBLIC_API_MODE=mock` does, so a `real` deploy carries it, unused.

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
- **Withdraw and payroll keep a list per viewer** (`createRecordList`, under
  `cadence:submissions:<kind>:<viewer>`), so a reload or a sign-out cannot forget a
  transaction that may have landed. A withdrawal's record holds its amount, which is
  what keeps it from being sent twice. A payroll payment that was not sent still cannot
  be signed after a reload: it is not paid, and a new run is for it.

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

The app offers no password: there is no field for one, and sign-in is by a 6-digit code
or link sent to the email (templates in `supabase/templates/`). That is the app, not the
Auth API behind it, which still accepts a password for sign-up and sign-in. That matters
because anyone can register a password for an address that is not theirs (**pre-registration**).

- With `enable_confirmations = false` (the old local value), that account has a session
  at once, and `accept_invite`'s check that the email is confirmed is vacuous.
- With `enable_confirmations = true` (now the local value, and what the hosted project's
  **Confirm email** must be), the attacker has no session until the address is confirmed,
  and `accept_invite` refuses it. **This does not finish the job**: when the real owner
  then signs in by code, the address becomes confirmed, and the password the attacker set
  still works (checked on the local stack: the password login answered 200 after the
  owner's code). So the Auth API's password sign-in has to be off, or the password has to
  be cleared when an address is first confirmed. The local config has no switch for the
  first (the CLI's `config.toml` has no such key) and whether the hosted dashboard has
  one was not checked, so the working fix is the second: a `BEFORE UPDATE OF
email_confirmed_at` trigger on `auth.users`, firing when it goes from null to set, that
  sets `encrypted_password := ''`. Tried by hand on the local stack, without `SECURITY DEFINER` (the function only
  edits `NEW`) and with `REVOKE ALL ... FROM PUBLIC`, it made the attacker's login fail
  with `invalid_credentials` and left the owner's code sign-in working. Not run against a
  hosted database. It is a migration, so it is the backend's to add and test; it is not in this PR.
- **Attacker-supplied `user_metadata` survives too.** `signUp` accepts a `data` object,
  and it is still on the user after the owner confirms. A trigger cannot clear it
  reliably: tried on the local stack, resetting `raw_user_meta_data` in the same trigger
  did not stick, because GoTrue writes its in-memory copy of the metadata back after the
  confirmation. So nothing that matters may read `user_metadata` (for example the
  custom-access-token hook's `tknonce`, when it lands): use `app_metadata` or a
  server-side binding, as the embedded-wallet spike suggests.

The code is entered on the form. The link
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
cannot be reached. The confirm page and the verify route are `no-store`. Guarded routes must never carry a secret in their
query string: it goes into `?next=` (minus Next's own `_rsc` and `__next*`).

The invite token and company name ride through sign-in as form fields and
inside the emailed link, so they survive opening the email on another device.
The link is built from `{{ .RedirectTo }}`, whose origin is `NEXT_PUBLIC_SITE_URL`
(`src/lib/auth/site-url.ts`), never the request's `Origin` or forwarded host: Next's
server-action origin check trusts `X-Forwarded-Host`, so a forged host could otherwise put
an attacker's origin in a link that Supabase sends to the victim. It is required in **any**
production build with Supabase configured, a Vercel Preview included (the build fails
without it), must be https (plain http only for localhost under `next dev` and in tests,
never in a production build), and may be unset under `next dev` and in tests, where the
request's `Origin` is the fallback. A Preview that uses Supabase therefore needs a fixed
https origin it will be served from (a branch alias or a domain assigned to the
environment, set as `NEXT_PUBLIC_SITE_URL` for Preview, and listed in the Supabase
redirect URLs); Vercel's per-deployment URL is not known at build time. A Preview with
the Supabase variables unset (the demo) needs none.

On the hosted project, list the redirect URLs **exactly**: `https://<site>/auth/confirm`
for each deployed origin, no `*` or `/**` on the host or the path. The local config keeps
`/**` entries for `localhost` only. Supabase may refuse a link whose query string (the
intent: invite, company, next) is not covered by the entry; if the first real email
shows that, widen only the query part of the entry, never the host. This has not been
tried against a hosted project.

### Session cookie and security headers

The session is in the `sb-*` cookies of `@supabase/ssr`, with options from one helper
(`src/lib/supabase/cookie-options.ts`) shared by the server, browser and middleware
clients: `SameSite=Lax`, `Path=/`, a 7-day `Max-Age` (the library's default is 400 days),
and `Secure` whenever the request is https (the page's protocol in the browser,
`X-Forwarded-Proto` or the URL on the server). It stays off on `http://localhost` and
`*.localhost`, where development and the e2e suite run. The cookie is **not httpOnly**:
the browser client reads the session (`getSession()` in `src/lib/api/index.ts`) to send
the token to the proof service, so script can read it. Closing that needs a same-origin
BFF that holds the cookie and adds the token itself; it is a decision for the team (see
the [completion plan](../docs/plans/2026-10-04-frontend-completion.md#before-going-live)).

`next.config.ts` sets these on every response, built from the `NEXT_PUBLIC_*` values the
build inlines (`src/lib/security-headers.ts`):

- `Content-Security-Policy` (stage 1): `default-src 'self'; script-src 'self'
'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src
'self'; connect-src 'self' <proof service, or the mock origin in mock mode> <Supabase>
https://api.turnkey.com <Solana RPC>; worker-src 'self' blob:; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. The `/dev/*` pages say
  `frame-ancestors 'self'` (they frame each other) and `X-Frame-Options: SAMEORIGIN`. The
  mock origin has to be listed in mock mode: MSW answers it inside the page, but the
  browser checks `connect-src` before the worker sees the request. `next dev` gets only
  `frame-ancestors`, because its refresh runtime needs `eval`. There is no `unsafe-eval`:
  zod is set `jitless` (`src/lib/zod-config.ts`, loaded first by
  `src/instrumentation-client.ts`) so it never probes for `new Function`, which a strict
  CSP reports as a violation.
- `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` (not `no-referrer`: Chrome then
  sends `Origin: null` with the confirm form's POST, which the verify route refuses),
  `X-Content-Type-Options: nosniff`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, and
  `Strict-Transport-Security: max-age=31536000` in production builds only. HSTS is a year
  and has no `includeSubDomains` for the first deploy, so a mistake costs one host for a
  year rather than every subdomain of the domain; raise it once the deploy has run clean.
  `poweredByHeader` is off.

The inline allowances are what stage 1 costs. A nonce-based stage 2 (`nonce` plus
`strict-dynamic`, no `unsafe-inline`) would remove them, and it is cheaper than it
sounds: the app routes and `/` already render per request (the viewer is read from
cookies and the responses are no-store), so a nonce does not take static pages away. It
is recommended before the wallet lands and is not done here. A new third-party origin
(analytics, fonts, an image host) needs adding to `connectSources` or the policy, and the
e2e suite fails on any violation (`e2e/csp.spec.ts` and the console watch in
`e2e/support/test.ts`).

## End-to-end tests

`pnpm e2e` drives the screens in a real browser ([Playwright](https://playwright.dev)),
against the production build in demo mode: the mock API and no Supabase, whatever
`.env.local` says (`playwright.config.ts` sets the environment). It is not part of
`pnpm test`, which stays a fast Vitest run over `src/`; CI runs it as the `e2e` job.

```sh
pnpm e2e                      # build, serve on :3300 and run everything (about a minute and a half to run)
pnpm e2e:build                # just the demo build (what CI runs first)
E2E_SKIP_BUILD=1 pnpm e2e     # reuse that build, e.g. when only a test changed
E2E_REUSE_SERVER=1 pnpm e2e   # reuse a server already on :3300 (you started it)
pnpm e2e e2e/auth.spec.ts     # one file; add -g "partial failure" for one test
pnpm e2e:ui                   # Playwright's UI mode: watch, time-travel, pick locators
```

The browser is Google Chrome when `/usr/bin/google-chrome-stable` (or
`PLAYWRIGHT_CHROME_PATH`) exists, and always on CI. Without it, install Playwright's
own once with `pnpm exec playwright install chromium`.

`E2E_SKIP_BUILD=1` only accepts a `.next` that `pnpm e2e:build` made (it leaves a marker
saying the build was mock mode with no Supabase); a plain `pnpm build` is refused, because
the suite would not be running against the demo. The server is not bound with `--hostname`:
Next would then build redirect URLs on that name and move the browser off `e2e.localhost`.

**Debugging.** A failed run leaves `playwright-report/` (open it with
`pnpm exec playwright show-report`) and, for a test that was retried on CI, a trace:
`pnpm exec playwright show-trace test-results/<test>/trace.zip` (CI uploads both as the
`playwright-report` artifact). Locally, `pnpm e2e --debug` steps through a test and
`--trace on` records one for every test.

**The demo host.** Tests open `http://e2e.localhost:3300`. The demo role is a cookie,
and cookies belong to the host and not the port, so a unique `*.localhost` name keeps it
apart from your dev server on `localhost:3000` (Chrome resolves every `*.localhost` to
the loopback). Every test also gets its own browser context, so no cookie carries over.

**Adding a test.** Import `test` and `expect` from `e2e/support/test`, not from
Playwright: it fails the test on an uncaught page error or any console error. A forced
mock scenario answers 4xx and 5xx on purpose and Chrome logs them, so name the statuses
and the URL it is expected for with `watch.allowStatus(409, /\/wrap\/confirm$/)`: the
same status on another URL still fails the test. In `e2e/support/demo.ts`: `signInAs(page, role)`
and `freshRecipient(page)` go through the demo panel, `setMock(page, "instant", ...)`
sets scenarios, `navLink` clicks a sidebar link, `expectNoHorizontalOverflow` checks
the layout. Two things to know about the mock:

- It lives in the page's memory, so a full load (`page.goto`, a reload, the sign-in form)
  starts from the seed data again. Set a scenario after the page you test has loaded
  and move on by clicking links, which are client-side navigations.
- The confirmation poll of a money flow takes about five seconds in real time. Add
  `"instant"` to the scenarios unless the test is about that wait.

Use accessible locators (`getByRole`, `getByLabel`, text) and web-first assertions
(`await expect(locator)...`, `expect.poll`), never a sleep. `e2e/support/known-noise.ts` lists console errors that someone else owns (each with a
probe that fails the suite the day the cause is gone, so the entry gets deleted). A new main screen goes in
`e2e/support/screens.ts`, which the responsive and accessibility specs walk; an
accessibility violation that cannot be fixed with the screen goes in the commented
`knownIssues` list of `e2e/support/a11y.ts`, with the screen and the axe rule, so it is
visible and not silenced.

**A failure is a finding, not noise.** Do not rerun a red test until it is green and do
not raise a timeout to get past it. Reproduce it (`--repeat-each=20`, `--workers=1`, the
trace), find the cause, and fix the app or the test. CI retries once so that a trace
exists, but a test that passes only on the retry is reported as flaky and treated as
a failure.

## Solana

Use `@solana/kit` only. Do not add `@solana/web3.js` 1.x or
`@solana/wallet-adapter-*`: both call `serialize()`, which throws on the v1
transactions a confidential transfer needs.

Get an RPC client from `createRpc()` in `src/lib/solana/rpc.ts`. Its transport
sets `maxSupportedTransactionVersion: 1` on every call that can return a
transaction, overriding whatever the caller passed.

`NEXT_PUBLIC_SOLANA_CLUSTER` selects `devnet` (local and previews) or `mainnet`
(production). It defaults to `devnet` under `next dev` and in tests only: a production
build without it fails, so a deploy cannot ship on devnet by forgetting it. Anything but
mainnet shows a DEVNET badge. `NEXT_PUBLIC_SOLANA_RPC_URL`
optionally replaces the cluster's public RPC. The Deposit screen reads the company
wallet's plain USDC from the chain (its associated token account, the one a wrap
debits) with `src/lib/solana/balances.ts`; mock mode answers that read from the mock.

## Deploys

Vercel builds this directory, with a preview for every pull request. The project's
**Root Directory must be `frontend/`**: the frontend is the only thing a Vercel project
may build. `.vercelignore` at the repository root keeps `spikes/`, `services/`,
`supabase/`, `ops/` and `docs/` out of an upload, but it only affects uploads from the
Vercel CLI: for Git-connected deploys the Root Directory setting is the real control. In particular
**`spikes/embedded-wallet/web` must never be deployed**: it has unauthenticated routes that
use the Turnkey root key (it is to be removed from `main`). Set the variables from
`.env.example` per environment: Production gets `mainnet`, Preview and Development get
`devnet`. Every environment that configures Supabase also sets `NEXT_PUBLIC_SITE_URL` (the https
origin it is served from), Production and Preview alike, and Production sets no
`NEXT_PUBLIC_DEV_TOOLS`.

`NEXT_PUBLIC_API_MODE` must be set outside `next dev`, or the build fails. A Preview
can run `mock` (with the Supabase variables unset, the demo viewer is on). Production must
be `real` with `NEXT_PUBLIC_PROOF_API_URL` set to an https URL, because mock mode is
refused on mainnet. Most routes the screens call do not exist on the proof service
yet, and in real mode nothing can be signed until #78 and #80, so a `real` deploy does
not work end to end today.
