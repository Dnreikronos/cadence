# Embedded wallet in the browser (#77)

Issue [#77](https://github.com/Dnreikronos/cadence/issues/77). #51 answered _which_
provider (Turnkey); this answers _how it plugs into the browser_.

**Verdict: go, conditional on** a hosted Supabase project that accepts an RS256
signing key, a real v1 transfer signed by a user session and confirmed on devnet, the
behaviour at session expiry, and the production-security decisions in "Security
review" below. A user who is signed in with Supabase gets a Turnkey embedded wallet,
and a session bound to that user returned a signed version 1 transaction, a signed
message, and 20 signed transactions in a row, with no second login and no prompt. The
parent API key can create the wallet and log the user in, and it was refused when it
tried to sign. It ran in the browser under the Next.js App Router, with React strict
mode off (see "Not done").

Everything in "What works" and "Things that would have bitten us" was run, not read,
unless it says "from the docs" or says otherwise. Each item in "Security review" is
tagged with how it is known. The scripts are in `spikes/embedded-wallet/`, and
`spikes/embedded-wallet/README.md` says how to rerun them. The runs also used a
throwaway Next page (`spikes/embedded-wallet/web/`), since removed from `main` because
of its unauthenticated routes; its last version is in git history at `475646b`. The
review findings were applied to the code after the runs described here, and the
committed scripts were not re-run (see "Not done").

## What works

Run in the browser (Next 15 App Router, `@turnkey/react-wallet-kit` 2.5.2) and, for
the timings, in Node as well.

| Step                                                     | Result                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Supabase session to Turnkey login                        | works, no separate Turnkey login                                                                    |
| Wallet kit in a client component                         | works with `organizationId` only, no Auth Proxy                                                     |
| Sign the v1 transaction (2,395 bytes, version byte 0x81) | returned a signed transaction, 0.5 s (the signature was not verified against the message)           |
| 20 signatures in a row, one session                      | 20 of 20 returned a signed transaction, 6.4 s in the browser (4.9 s in Node, median 244 ms), silent |
| `signMessage`                                            | ok, returns `r`, `s`, `v`; the signature verified against the address in Node                       |
| Renew the session                                        | ok, a new one-hour session                                                                          |
| Parent API key signing for the user                      | refused (`request not authorized`)                                                                  |
| Who is in a user's sub-organization                      | one user, created from the OIDC identity                                                            |

That the parent holds no credential in the sub-organization rests on the signing
refusal above. The check that was meant to show it listed the users before the login,
on a user created with no API keys, so it could not have found the parent key; the
committed script now checks after the login, and that corrected check was not run.

The transaction signed is the earlier spike's synthetic confidential transfer, with
its signer swapped for the user's wallet. It was **not** broadcast: it is not
submittable. The earlier spike ([#51](../../../spikes/wallet-providers/README.md))
confirmed a real v1 transfer on devnet through Turnkey with a root key; this spike
shows the same signing works for a user-owned wallet, but a real broadcast from the
user's session is still to be shown (see "Not done").

Extension wallets cannot do this. Phantom and Brave Wallet advertise only
`["legacy", 0]` for `signTransaction` and `signAndSendTransaction`, never version 1
(read through the Wallet Standard, without connecting, in Brave on 2026-10-03). That
check was run with an inline script that is not in the repo; the earlier Phantom
evidence is in [`spikes/wallet-providers/README.md`](../../../spikes/wallet-providers/README.md).
Solflare and Backpack were checked on 2026-10-10 the same way (a local page reading
the Wallet Standard registrations, without connecting): **Solflare advertises
`["legacy", 0, 1]`** for both features, and Backpack `["legacy", 0]`. Solflare's
advertised support was not exercised: nothing was signed with it. Phantom and Backpack
still cannot sign a v1 transaction, so the embedded wallet stays the default for every
user, as #77 assumed; Solflare is a possible second path for users who already have it.

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
   as a top-level claim. The nonce only binds the token to a key that the user's own
   session chose. That also means anyone holding a user's Supabase **refresh** token
   can call `updateUser` with a key of their choice, refresh, and obtain a Turnkey
   session for that user's wallet. A stolen Supabase session is therefore signing
   authority, not just data access. (A stolen access token alone is not enough,
   because minting the new token needs the refresh token.)
4. The browser sends that access token and the public key to our route. The route
   holds the parent API key, finds the user's sub-organization from the token
   (`getSubOrgIds`) or creates it (`createSubOrganization` with
   `oauthProviders: [{ providerName, oidcToken }]`), and calls `oauthLogin`.
5. The route returns the session; the browser keeps it with `storeSession` and signs
   with the wallet kit's `signTransaction` and `signMessage`.

That route is what #78 becomes. The lookup by token identity (`iss`, `sub`, `aud`)
should make it idempotent, but that was not tested, and it is racy as written: two
concurrent first logins can both find nothing and both create a sub-organization. A
real route needs a lock or a uniqueness guarantee.

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
  key pair, authorised by a request stamped with the old one. The error came from an
  earlier ad hoc run of `step4-session.mjs`; the committed script no longer reproduces
  it, because it always registers a new key.
- **The old key keeps working after renewal** until its own expiry. Renewal should
  delete the old key; deleting was not tried.

## Sessions

`oauthLogin` accepted `expirationSeconds` of 900, 86,400, 604,800 and 2,592,000 (30
days), and the session's expiry matched the requested value to within a second each
time; no cap was hit up to 30 days. So the length is our choice, not a limit. A 20-payment run signs in about 6 seconds, so a short session
(for example one hour, renewed while the person is active) covers a run with room to
spare. A longer session leaves a signing key in the browser for longer.

A key that was never logged in is refused.

## The caveat to decide on: who can mint a token can log in

The signing test shows the parent API key is refused. It does not show that
**Cadence** cannot get access. Anyone who can make the issuer vouch for a user can
obtain a session for that user's wallet, the way OIDC login works with any provider
its operator also controls. That is:

- **Holders of the Supabase service role.** It can create a sign-in link and set a
  user's metadata, so it can produce a valid token with a `tknonce` for a key the
  holder generates. The spike's own scripts do this for test users.
- **Anyone who can edit the hook or run migrations**, for example through CI
  credentials: the hook decides what goes into the token.
- **Anyone holding the RS256 signing private key.** They can mint a token for any
  `sub` without touching Supabase. They need the user's `sub`, and user ids may be
  visible to teammates through RLS (unverified).
- **And, because the proof service holds customers' ElGamal secrets (ADR B17), the
  same party could also build the matching confidential-transfer proofs**, so Cadence
  could complete a transfer end to end.

So ADR B9's "the server can never move funds" and "no customer signing key reaches
our infrastructure" hold for keys we **store**, but they are **not enforced
cryptographically** against Cadence's own administrators. The decision log and the
product copy must say that, and not claim more. This belongs in the O2 custody
review. A passkey or a second factor held only by the user would narrow it; that is a
product decision, listed in "Decisions for the team".

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

## Security review

A code review and a security review read this spike. Each item is tagged **[verified
in code/docs]**, **[from general knowledge of Turnkey/Supabase, to verify]** or
**[unverified]**. Production risks, most serious first.

1. **The user is the sub-organization's root user, and the session key can register
   new keys.** [verified in code/docs] `step4-session.mjs` registered a new key
   stamped by the session key, so one moment of XSS or extension access can become a
   persistent, renewable key. A root user can probably also export the wallet and add
   API keys, and Turnkey policies may not constrain root users [from general
   knowledge of Turnkey, to verify]. The mitigation is a decision: a user-held
   passkey as the root user, with the OAuth session as a policy-limited non-root
   user. Whether Turnkey's Solana policies can parse v1 transactions is [unverified]
   and has to be tested first.
2. **A stolen Supabase session is a stolen wallet** (see "How the login works").
   [verified in code/docs] Cheap mitigations:
   - emit `tknonce` from the hook only when the latest authentication is recent (the
     `amr` timestamp, under about five minutes), and require aal2 for company admins
     [hook event fields to verify];
   - write the nonce through a one-time server-side binding (a SECURITY DEFINER
     function or `app_metadata`) instead of user-writable metadata [from general
     knowledge of Supabase, to verify];
   - a shorter `jwt_expiry` (900 s; the local config has 3600) [verified in code/docs
     for the current value];
   - keep tokens in httpOnly cookies with `@supabase/ssr`;
   - email the user when a new signing key is bound.
3. **A compromised login route.** [verified in code/docs] It chooses `rootUsers` for
   every new sub-organization, the spike uses the root-user API key, and the parent
   has no way to revoke a user's session [the last part from general knowledge of
   Turnkey, to verify]. Mitigations: a dedicated API-only parent key, hard-coded
   `rootUsers`, running the route without the Supabase service role and in a separate
   service from anything that holds it, and a nightly audit with `getUsers` that
   checks each sub-organization has one root user, no API keys it should not have,
   and quorum threshold 1, alerting on drift.
4. **XSS, dependencies and extensions.** The session key signs silently, and so would
   a thief, for 20 transactions. [verified in code/docs for the silent signing] A
   nonce-based `script-src` with `strict-dynamic` and no `unsafe-eval` or
   `unsafe-inline`, a `connect-src` allowlist (self, Supabase, `api.turnkey.com`, the
   RPC), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, Trusted
   Types, pinned dependencies and `npm audit` in CI. A CSP lowers the odds, not the
   impact. A step-up (WebAuthn) for transfers above a limit is a product decision.
   [from general knowledge, to verify]
5. **Renewal registers a new key and the old one stays valid**, so a thief can keep
   renewing. [verified in code/docs] Set an absolute session age that requires a
   fresh OIDC login, delete the old key on renewal and on logout, and test deletion
   (not tried).
6. **Session length.** A 20-payment run takes about six seconds [verified in code/docs].
   The reviewer suggests 15 to 60 minutes with an idle timeout rather than days. This
   is a decision.
7. **Supabase email is the root of trust.** `supabase/config.toml` has
   `enable_confirmations = false` and password sign-up enabled [verified in
   code/docs], so pre-registering a victim's email is possible, and the spike route
   does not check `email_verified` [verified in code/docs]. Turn confirmations on,
   use email OTP only in production, and check the claim in the route. A mailbox
   takeover is a wallet takeover; whether that is acceptable for payroll amounts is a
   decision. There is no recovery story: a deleted and re-created user gets a new
   `sub`, hence a new sub-organization, and the old funds are stranded [from general
   knowledge of Supabase and Turnkey, to verify], and `TRANSFER_API.md` says wallet
   links cannot be reassigned [verified in code/docs]. The issuer URL is baked into
   every sub-organization, so choose the final custom-domain issuer before the first
   production sub-organization, and rotate signing keys by publishing the new key
   beside the old.
8. **The spike route never verifies the token, issuer or audience itself.**
   [verified in code/docs] A real route must (with `jose` against our JWKS: `iss`,
   `aud`, `exp`, non-anonymous, `email_verified`, `tknonce`) and rate-limit per `sub`
   and per IP. Whether Turnkey enforces an issuer allowlist when creating
   sub-organizations is [unverified]: an attacker hosting their own OIDC issuer could
   otherwise create unlimited sub-organizations and consume quota.

Spike-specific: the removed Next page had two unauthenticated dev routes, and the
spike used a tunnel that exposes the whole local Supabase gateway. Before the page was
removed, the README carried the warnings, the dev server bound to `127.0.0.1`,
`/api/dev-session` refused production and non-`@cadence.test` emails, and
`/api/turnkey-login` ignored `email` and `expirationSeconds` from the body, took the
email from the token and fixed the session length at one hour. Those changes were
applied after the runs described above and not re-run.

Found while reviewing, and worth knowing before #78: the spike's routes read the
Turnkey credentials with `readFileSync(path.join(process.cwd(), "..", ".env"))`. Next's
build treated that file as an asset and **copied the whole `.env`, private key
included, into `.next/server/static/media/`** (not into the public `static/`
folder, and git-ignored, but it sits in the build output and would travel with a
deployment or a build cache). The same folder then showed up in a search for
secrets. A real route must take secrets from `process.env`, set in the hosting
platform, and never from a file read by path. The build folder was deleted.

### Decisions for the team

1. A user-held passkey as the root user, or plain OAuth as the root user.
2. Step-up (WebAuthn) for binding a new signing key and for large transfers.
3. Session length and an absolute maximum.
4. The recovery and export story, and the final issuer domain.
5. Splitting the Turnkey parent key and the Supabase service role into different
   services, with a nightly audit.
6. Accepting email OTP as the root of trust, or requiring MFA for company admins.
7. How product copy states custody.

## Rerun on 2026-10-10

`step3-sign.mjs` was run again, unchanged apart from a new signature check, against a
fresh throwaway Turnkey organization and the local Supabase (CLI 2.119.0) behind a quick
tunnel, with an RS256 key and `hook.sql` installed:

| Check                                                       | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| Sub-organization after the login                            | 1 user, 1 OAuth provider, 1 API key (the session's)        |
| Any API key on the user equals the parent's public key      | no                                                         |
| Session signs the v1 transaction (2,395 bytes, 0x81)        | ok                                                         |
| Signed message equals the one sent                          | yes                                                        |
| The wallet's ed25519 signature verifies against the message | yes (decoded with `@solana/kit` 8.4.0)                     |
| Parent signing for the user                                 | refused (`request not authorized`)                         |
| `signMessage`                                               | ok, verifies                                               |
| 20 signatures in a row                                      | 0 failed, 5.4 s total, median 263 ms                       |

This runs the corrected parent-key check (after the login) and the hook's nonce check in
Supabase for the first time: Turnkey accepted the login, so the token carried the
`tknonce` the hook copied. The signature check stands in for a broadcast: the bytes
Turnkey returns are a valid signature over the unchanged message, which is what a
validator checks. Broadcasting a real `POST /transfer` transaction moved to
[#157](https://github.com/Dnreikronos/cadence/issues/157), because the configure, enroll
and apply-pending routes it needs do not exist yet.

## Not done

Moved out of this spike when #77 was closed:

- A real v1 transaction from `POST /transfer`, signed by a user session and broadcast
  and confirmed on devnet; the session's behaviour at and after expiry and with two
  tabs; deleting the old key on renewal; running under React strict mode (the web page
  ran with `reactStrictMode: false`, now only in git history at `475646b`)
  → [#157](https://github.com/Dnreikronos/cadence/issues/157).
- The real key-derivation message from #50 through `signMessage` (the spike signed a
  sample string; Phantom rejected the real bytes)
  → [#63](https://github.com/Dnreikronos/cadence/issues/63).
- A hosted Supabase project with an RS256 key
  → [#100](https://github.com/Dnreikronos/cadence/issues/100).
- Turnkey plan and signature budget
  → [#71](https://github.com/Dnreikronos/cadence/issues/71).

Still not run: the login route's validation and the dev route's limits (both in the
removed web page), the `aud` array form, and browser console health.

- Signing a v1 transaction with Solflare, which advertises version 1.
- Cleanup: the runs left throwaway sub-organizations named `spike-<timestamp>` in the
  `cadence` Turnkey organization and in the one used on 2026-10-10. They stay orphaned:
  deleting a sub-organization has to be approved by its own root user, an OIDC identity
  whose issuer (a quick-tunnel URL) no longer exists. They hold no funds, and the API
  keys used by the runs were revoked on 2026-10-10.

## Sources

Turnkey docs: [social logins](https://docs.turnkey.com/features/authentication/social-logins),
[OAuth login](https://docs.turnkey.com/api-reference/activities/login-with-oauth),
[create sub-organization](https://docs.turnkey.com/api-reference/activities/create-sub-organization),
[advanced backend authentication](https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react/advanced-backend-authentication).
