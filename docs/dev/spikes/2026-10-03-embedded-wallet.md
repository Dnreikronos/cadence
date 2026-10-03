# Embedded wallet in the browser (#77): findings so far

Issue [#77](https://github.com/Dnreikronos/cadence/issues/77). #51 answered *which*
provider (Turnkey); this answers *how it plugs into the browser*.

**Status: partly done, blocked on credentials and a public issuer.** Two of the
eight checks are finished. The rest need a Turnkey organization and a Supabase
issuer that Turnkey can reach, which this checkout does not have. What is verified
and what comes only from documentation is marked on every line.

## Done: extension wallets do not advertise transaction version 1

Read from the Wallet Standard `solana:signTransaction` and
`solana:signAndSendTransaction` features on an ordinary page, without connecting
or signing, in the browser the team uses for checks (Brave, 2026-10-03):

| Wallet | `signTransaction` | `signAndSendTransaction` | `signMessage` |
|---|---|---|---|
| Phantom | `["legacy", 0]` | `["legacy", 0]` | yes |
| Brave Wallet | `["legacy", 0]` | `["legacy", 0]` | yes |
| Solflare | not installed, not checked | | |
| Backpack | not installed, not checked | | |

Neither installed wallet advertises version 1, and a confidential transfer needs it
(ADR B2). This matches the earlier Phantom result in
`spikes/wallet-providers/README.md`. So #77's premise holds for the two wallets
checked: every user needs an embedded wallet. Solflare and Backpack still need
someone with them installed; the check is the same few lines of script.

## Done: the Supabase issuer serves what Turnkey asks for

Turnkey verifies an OIDC token by fetching the issuer's
`/.well-known/openid-configuration` and the `jwks_uri` it names
([social logins](https://docs.turnkey.com/features/authentication/social-logins)).
Supabase's auth server (the same GoTrue the hosted project runs) answers both, on
the local stack:

- `GET /auth/v1/.well-known/openid-configuration` returns `200` with `issuer`
  (`http://127.0.0.1:54321/auth/v1` locally), `jwks_uri` and
  `id_token_signing_alg_values_supported`.
- `GET /auth/v1/.well-known/jwks.json` returns an ES256 key.

So the issuer side is not a blocker in principle. **It is a blocker in practice for
local work:** Turnkey's enclaves fetch these documents from the public internet,
and `http://127.0.0.1` is not reachable. Checking against a real token also needs
the hosted project (#100) or a tunnel whose URL is set as the auth server's issuer.

## From the documentation, not tried

All of this is from Turnkey's docs and has not been run:

- **Login.** `oauthLogin` takes `oidcToken` and the browser's `publicKey`. Turnkey
  enforces that the token's `nonce` **or** `tknonce` claim equals
  `sha256(publicKey)`, so a token cannot be replayed against another key
  ([OAuth login](https://docs.turnkey.com/api-reference/activities/login-with-oauth)).
- **Claims checked:** `iss` (must match the registered provider), `aud` (must match
  the configured client id), `exp`, and the nonce above. The sub-organization is
  identified by `iss`, `sub` and `aud`.
- **Sub-organization from an identity.** `createSubOrganization` with
  `oauthProviders: [{ providerName, oidcToken }]` stores the claims, not the token
  ([create sub-organization](https://docs.turnkey.com/api-reference/activities/create-sub-organization)).
- **Backend flow.** The "advanced backend authentication" guide has the browser
  generate an API key pair (`createApiKeyPair`), send the public key to our backend,
  and have the backend call `createSubOrganization` / `oauthLogin`, returning a
  session JWT the browser keeps with `storeSession`. The guide does not say whether a
  backend can log in a user it verified itself without a nonce-bound token, so I
  assume it cannot.
- **Auth Proxy.** `TurnkeyProvider` takes `organizationId` and `authProxyConfigId`;
  omitting the second disables the proxy for a custom backend.

## The open problem: a Supabase access token has no nonce

A plain Supabase access token carries neither `nonce` nor `tknonce`, and it cannot,
because the browser only picks its Turnkey public key at login. Turnkey would
reject it. This is the first thing the spike has to answer.

**A path worth trying (a hypothesis, not tested):**

1. The browser creates the Turnkey API key pair and computes
   `tknonce = sha256(publicKey)`.
2. It writes that into the user's metadata with `supabase.auth.updateUser({ data })`,
   then calls `refreshSession()`.
3. A Supabase **Custom Access Token Hook** (a Postgres function the auth server
   calls when it mints a token) copies the value from the user's metadata into the
   token as `tknonce`.
4. The browser sends that fresh access token to Turnkey's `oauthLogin` together with
   the public key.

Why it might work: the hook runs on every token mint, and `tknonce` only has to match
a key the user chose, so letting the user set it opens nothing. What could break it:
the refreshed token's `iss` or `aud` not matching what Turnkey registered, the hook
not firing on a refresh, or Turnkey refusing a token whose `aud` is the generic
`authenticated`.

If it does not work, the fallbacks are Turnkey's own email OTP (a second, separate
code, which breaks "without a separate Turnkey login") or our backend minting a
dedicated, short-lived OIDC token for Turnkey. Both change the product, so decide
after the test.

## Still to run

Each of these needs the setup in the next section.

1. Supabase session to Turnkey login through the nonce path above; record what works.
2. `@turnkey/react-wallet-kit` inside a client component on the App Router.
3. A small `@solana/kit` signer wrapping Turnkey's `signTransaction`.
4. Sign the unsigned v1 transaction from `POST /transfer` and confirm it on devnet,
   as a Supabase-signed-in user with no separate Turnkey login.
5. Sign 20 transactions silently inside one read-write session; note the session
   length and refresh behaviour (this decides how a 20-person run behaves).
6. `signMessage` for the key-derivation message (#50) through Turnkey, because
   Phantom rejects it.
7. Solflare and Backpack capability check.

## What is needed to finish

- **A Turnkey organization and a way to call it from this repo.** No Turnkey setting
  was found in any ignored environment file in the repo's checkouts, and the earlier
  experiment's credentials live outside the repo. The spike needs the organization
  id and an API key pair for a disposable devnet organization, in a git-ignored
  `.env` under `spikes/embedded-wallet/`. Turnkey dashboard: API Keys is on My
  Profile, and the action is labelled New API Key.
- **An issuer Turnkey can reach.** The hosted Supabase project (#100), or a tunnel to
  the local stack with the auth server's issuer set to the tunnel URL.
- **The Supabase side registered in Turnkey** as an OIDC provider for that
  organization, with the audience the access tokens carry.
