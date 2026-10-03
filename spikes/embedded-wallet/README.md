# Embedded wallet spike (#77)

Throwaway code for [#77](https://github.com/Dnreikronos/cadence/issues/77). The
findings are in
[`docs/dev/spikes/2026-10-03-embedded-wallet.md`](../../docs/dev/spikes/2026-10-03-embedded-wallet.md).
Do not import anything from here into the product.

> **Warning: local only.** Run this against a **throwaway Turnkey organization** and
> a **local Supabase** (`supabase start`), never against a real organization or a
> hosted Supabase project. The scripts create real sub-organizations and use real
> credentials, and the web app has two unauthenticated routes (`/api/dev-session` mints
> a login for a test email with the Supabase service role; `/api/turnkey-login` uses the
> Turnkey parent key). **Never deploy the web app**, and never bind it to anything but
> `127.0.0.1` (`npm run dev` does that).

## What is here

- `lib.mjs`, `step1-nonce.mjs` to `step4-session.mjs`: Node scripts. They sign a test
  user in to Supabase, bind a Turnkey key through the access token, create a
  sub-organization, log in, sign a v1 transaction and a message, check that the
  sub-organization has one user created from the OIDC identity, check that the parent
  cannot sign (the signing refusal is what shows the parent holds no authority over
  the wallet), and probe session lengths and renewal.
- `whoami.mjs`: a read-only check that the Turnkey API key works.
- `hook.sql`: the Custom Access Token Hook that copies `user_metadata.tknonce` into
  the access token.
- `web/`: a small Next page that runs the same flow in a browser with
  `@turnkey/react-wallet-kit`. Its routes stand in for #78 (`/api/turnkey-login`) and
  for the email sign-in (`/api/dev-session`).

## Rerunning it

You need a Turnkey organization (a disposable devnet one), Docker, and `cloudflared`.

1. **Turnkey credentials** in `spikes/embedded-wallet/.env` (git-ignored):

   ```
   TURNKEY_ORGANIZATION_ID=...
   TURNKEY_API_PUBLIC_KEY=...   # 66 hex characters, compressed P-256
   TURNKEY_API_PRIVATE_KEY=...  # 64 hex characters
   ```

   Create the key in the Turnkey dashboard under My Profile → API Keys → New API Key.
   The spike used a root user key; revoke it afterwards.

2. **A public issuer.** Turnkey cannot reach `127.0.0.1`, so open a tunnel and make the
   auth server use its URL as the issuer. A new tunnel URL is needed whenever the
   signing key changes, because Turnkey caches an issuer's key set.

   ```sh
   cloudflared tunnel --url http://127.0.0.1:54321
   ```

   **Know what this exposes.** The quick tunnel publishes the **entire local Supabase
   gateway** on the internet: the auth admin API, the REST and Postgres REST endpoints,
   everything behind port 54321, protected only by the CLI's well-known default keys.
   The tunnel URL also ends up in every token's `iss` claim and in Turnkey's logs. Run
   the tunnel only while you are testing, kill it afterwards, and keep nothing real in
   that Supabase. Alternatively put Cloudflare Access in front of the tunnel and leave only the
   discovery and key-set paths (`/auth/v1/.well-known/*`) public. That was not tried.

3. **Supabase config** (temporary, do not commit) in `supabase/config.toml`:

   ```toml
   [auth]
   external_url = "https://<your-tunnel>.trycloudflare.com/auth/v1"
   signing_keys_path = "./signing_keys.json"

   [auth.hook.custom_access_token]
   enabled = true
   uri = "pg-functions://postgres/public/custom_access_token_hook"
   ```

   Turnkey rejects ES256, so generate an **RS256** key (the file is a private key; keep
   it out of git; `supabase/.gitignore` ignores `signing_keys.json`):

   ```sh
   pnpm dlx supabase@2.119.0 gen signing-key --algorithm RS256
   ```

   The command writes `supabase/signing_keys.json` itself (the path set above) and may
   ask whether to overwrite an existing file. Replacing the key means a new tunnel URL
   too, because Turnkey caches the key set.

   The CLI is pinned to 2.119.0, the version the spike ran with; `lib.mjs` pins it too
   (`SUPABASE_CLI_VERSION`) for `supabase status`.

4. **Start Supabase and install the hook:**

   ```sh
   pnpm dlx supabase@2.119.0 start
   docker exec -i supabase_db_cadence psql -U postgres -d postgres < spikes/embedded-wallet/hook.sql
   ```

5. **Run the scripts** from `spikes/embedded-wallet/` after `npm install`:

   ```sh
   node whoami.mjs
   node step1-nonce.mjs
   node step2-turnkey.mjs        # add `bytes` to see the wrong nonce encoding fail
   node step3-sign.mjs
   node step4-session.mjs
   ```

6. **The browser page.** In `web/`, run `npm install`, create `web/.env.local` with
   `NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID`, `NEXT_PUBLIC_SUPABASE_URL` (the tunnel URL),
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`, then `npm run dev`
   and open http://127.0.0.1:3400 (the dev server binds to `127.0.0.1` only). Press the
   buttons in order. `next.config.mjs` sets `reactStrictMode: false`; Next's default is
   `true`.

Next copies a file that a route reads by path into its build output: the spike's
routes read `../.env`, so a copy of it (private key included) ends up under
`web/.next/`. That folder is git-ignored, but delete it (`rm -rf web/.next`) when you
are done, and never copy this pattern: real code reads secrets from `process.env`.

Each run creates throwaway sub-organizations named `spike-<timestamp>` in the Turnkey
organization. Delete them from the dashboard when you are done.
