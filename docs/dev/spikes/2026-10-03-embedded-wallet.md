# Embedded wallet in the browser (#77)

Issue [#77](https://github.com/Dnreikronos/cadence/issues/77). #51 answered *which*
provider (Turnkey); this answers *how it plugs into the browser*.

**Verdict: go, with four things to build and one caveat to decide on.** A user who
is signed in with Supabase gets a Turnkey embedded wallet, signs a version 1
transaction, a message, and 20 transactions in a row in one session, with no second
login and no prompt. The parent API key can create the wallet and log the user in,
and it cannot sign. It works in the browser under the Next.js App Router.

Everything below was run, not read, unless it says "from the docs". The code is in
`spikes/embedded-wallet/` (scripts and a throwaway Next page), and
`spikes/embedded-wallet/README.md` says how to rerun it.

## What works

Run in the browser (Next 15 App Router, `@turnkey/react-wallet-kit` 2.5.2) and, for
the timings, in Node as well.

| Step | Result |
|---|---|
| Supabase session to Turnkey login | works, no separate Turnkey login |
| Wallet kit in a client component | works with `organizationId` only, no Auth Proxy |
| Sign the v1 transaction (2,395 bytes, version byte 0x81) | ok, 0.5 s |
| 20 signatures in a row, one session | 20 of 20 ok, 6.4 s in the browser (4.9 s in Node, median 244 ms), silent |
| `signMessage` | ok, returns `r`, `s`, `v`; the signature verified against the address in Node |
| Renew the session | ok, a new one-hour session |
| Parent API key signing for the user | refused (`request not authorized`) |
| Who is in a user's sub-organization | exactly one user, the person; none holds the parent key |

The transaction signed is the earlier spike's synthetic confidential transfer, with
its signer swapped for the user's wallet. It was **not** broadcast: it is not
submittable. The earlier spike ([#51](../../../spikes/wallet-providers/README.md))
confirmed a real v1 transfer on devnet through Turnkey with a root key; this spike
shows the same signing works for a user-owned wallet, but a real broadcast from the
user's session is still to be shown (see "Not done").

Extension wallets cannot do this. Phantom and Brave Wallet advertise only
`["legacy", 0]` for `signTransaction` and `signAndSendTransaction`, never version 1
(read through the Wallet Standard, without connecting, in Brave on 2026-10-03).
Solflare and Backpack were not installed to check. So every user needs the embedded
wallet, as #77 assumed.

## How the login works

A plain Supabase access token cannot log in to Turnkey: Turnkey requires the token's
`nonce` or `tknonce` claim to equal `sha256(publicKey)` of a key the browser picks at
login, and Supabase tokens have neither. This works:

1. The browser creates its Turnkey key pair (`createApiKeyPair`). The private half
   stays in the browser's IndexedDB, managed by the SDK.
2. It writes `tknonce = sha256(publicKey)` into the user's metadata
   (`supabase.auth.updateUser`) and calls `refreshSession()`.
3. A Supabase **Custom Access Token Hook**
   (`spikes/embedded-wallet/hook.sql`) copies `user_metadata.tknonce` into the token
   as a top-level claim. Letting the user set it opens nothing: it only binds the
   token to a key the user chose.
4. The browser sends that access token and the public key to our route. The route
   holds the parent API key, finds the user's sub-organization from the token
   (`getSubOrgIds`) or creates it (`createSubOrganization` with
   `oauthProviders: [{ providerName, oidcToken }]`), and calls `oauthLogin`.
5. The route returns the session; the browser keeps it with `storeSession` and signs
   with the wallet kit's `signTransaction` and `signMessage`.

That route is what #78 becomes. It is idempotent by construction: the sub-organization
is found by the token's identity (`iss`, `sub`, `aud`), so a retry never makes a
second wallet.

## Things that would have bitten us

- **Turnkey rejects ES256.** Supabase signs with ES256 by default and Turnkey answered
  `OIDC Algorithm is not valid: ES256`. The auth server has to sign with **RS256**.
  Locally that is `supabase gen signing-key --algorithm RS256`. Whether the hosted
  project accepts an imported RS256 key was not checked and has to be before #100.
- **Turnkey caches the issuer's key set.** After changing the signing key on an
  issuer URL it had already fetched, Turnkey kept the old key set and answered
  `No matching key found in JWKS for kid ...`. A new issuer URL fixed it. In
  production, never rotate the signing key by replacing it; publish the new key next
  to the old one first.
- **The nonce is the hash of the key's hex text.** `sha256(utf8(publicKeyHex))` works,
  where the key is the 66-character compressed P-256 key. Hashing the key's raw bytes
  fails at login with `tknonce claim (...) is different from sha256(pubkey=...)`.
- **Turnkey checks the nonce at login, not when creating the sub-organization.**
- **The issuer must be public.** Turnkey fetches `/.well-known/openid-configuration`
  and the key set from the internet; `127.0.0.1` is unreachable. Locally a Cloudflare
  quick tunnel works, with `[auth] external_url` set to the tunnel URL so the token's
  `iss` matches. Supabase's auth server does serve the discovery document.
- **`aud` differs by how the token was made.** Right after `verifyOtp` the token has
  `aud: ["authenticated"]`; after `refreshSession` it is the string `"authenticated"`.
  Only the refreshed form was tested, and it is the one the flow sends.
- **A session key cannot be registered twice.** Renewing with the same public key
  fails (`user credential public keys must be unique`). Renewal registers a **new**
  key pair, authorised by a request stamped with the old one.
- **The old key keeps working after renewal** until its own expiry. Renewal should
  delete the old key; deleting was not tried.

## Sessions

`oauthLogin` accepted `expirationSeconds` of 900, 86,400, 604,800 and 2,592,000 (30
days) and the session lasted exactly that long; no cap was reached. So the length is
our choice, not a limit. A 20-payment run signs in about 6 seconds, so a short session
(for example one hour, renewed while the person is active) covers a run with room to
spare. A longer session leaves a signing key in the browser for longer.

A key that was never logged in is refused.

## The caveat to decide on: who can mint a token can log in

The quorum check shows our **API key** has no authority over a user's wallet, and the
signing test shows the parent is refused. It does not show that **Cadence** cannot
get access. Whoever can mint tokens for the issuer can log in as any user: Cadence
holds Supabase's service role, which can create a sign-in link and set a user's
metadata, and so can produce a valid token with a `tknonce` for a key it generates.
That is how OIDC login works with any provider the operator also controls.

So "no customer signing key reaches Cadence" (ADR B9) holds as a statement about keys
we store, and it holds operationally, but it is **not enforced cryptographically**
against Cadence's own Supabase administrators. This belongs in the O2 custody review,
and the copy about it should say what is true. A passkey or a second factor held only
by the user would close it; that is a product decision, not part of this spike.

## For #78, #80 and #100

- Ship `custom_access_token_hook` as a real migration with a test, not the spike's SQL.
- Put an **RS256** signing key on the hosted Supabase project before #100 is called
  done, and plan rotation around Turnkey's key-set cache.
- The spike used the organization's **root user** API key. For the real route, create a
  dedicated API-only user whose policy allows only creating sub-organizations and
  logging users in, and confirm it still cannot sign. Keep it in server env only.
- Rate-limit the login route: each call can create a sub-organization.
- Pick the session length, and have renewal register a new key and delete the old one.
- Local development needs the tunnel; document it (the spike README has the steps) or
  point local work at a hosted project.

## Not done

- A real v1 transaction from `POST /transfer`, signed by a user session and broadcast
  and confirmed on devnet. This needs funded accounts and the proof service.
- The behaviour at and after session expiry, and with two tabs.
- Deleting the old key on renewal.
- The real key-derivation message from #50 through `signMessage`. The spike signed a
  sample string; the real message's bytes are the true test, because Phantom rejected
  it.
- A hosted Supabase project with an RS256 key.
- The `aud` array form, and browser console health (the page was driven by script, and
  its console was not read).
- Solflare and Backpack.
- Turnkey plan and signature budget ([#71](https://github.com/Dnreikronos/cadence/issues/71)).
- Cleanup: the runs created several throwaway sub-organizations in the `cadence`
  Turnkey organization, named `spike-<timestamp>`. They can be deleted from the
  dashboard. The API key used is the root user's; revoke it from My Profile → API Keys
  when the spike is no longer needed.

## Sources

Turnkey docs: [social logins](https://docs.turnkey.com/features/authentication/social-logins),
[OAuth login](https://docs.turnkey.com/api-reference/activities/login-with-oauth),
[create sub-organization](https://docs.turnkey.com/api-reference/activities/create-sub-organization),
[advanced backend authentication](https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react/advanced-backend-authentication).
