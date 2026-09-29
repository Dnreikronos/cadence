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

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Layout

```
src/app/            App Router. (auth)/ for sign-in; company/, me/, audit/ per role
src/components/     app/ (signed-in shell), landing/, ui/ (shadcn)
src/lib/            auth/ (route guard), supabase/, solana/, api/
src/middleware.ts   role-based route guard
```

## Route guard

`src/middleware.ts` refreshes the Supabase session on every request and guards
three areas by the role in the viewer's `memberships` rows:

| Path | Role |
|---|---|
| `/company/*` | `admin` |
| `/me/*` | `recipient` |
| `/audit/*` | `auditor` |

A signed-out visit goes to `/sign-in?next=<path>`. A signed-in user without the
role goes to `/`. If Supabase is unreachable or unconfigured, guarded areas are
treated as signed out. The rules live in `src/lib/auth/guard.ts`.

Row-level security is still the authorization boundary: the middleware only
decides which page to show.

## Solana

Use `@solana/kit` only. Do not add `@solana/web3.js` 1.x or
`@solana/wallet-adapter-*`: both call `serialize()`, which throws on the v1
transactions a confidential transfer needs.

Get an RPC client from `createRpc()` in `src/lib/solana/rpc.ts`. Its transport
sets `maxSupportedTransactionVersion: 1` on every call that can return a
transaction, overriding whatever the caller passed.

`NEXT_PUBLIC_SOLANA_CLUSTER` selects `devnet` (local and previews) or `mainnet`
(production). Anything but mainnet shows a DEVNET badge.

## Deploys

Vercel builds this directory (project root directory `frontend/`), with a
preview for every pull request. Set the variables from `.env.example` per
environment: Production gets `mainnet`, Preview and Development get `devnet`.
