import { parentClient } from "../../lib"

// SPIKE ROUTE, DO NOT COPY AS IS.
//
// What #78 will become: the browser sends its Supabase access token (carrying the
// tknonce for the key it just generated) and that key's public half. This route holds
// the parent API key, which can create sub-organizations and log users in but cannot sign.
//
// What this route deliberately does NOT do, and a real route must:
// - Verify the JWT itself before touching the parent client (for example with `jose`
//   against our JWKS): iss, aud, exp, not an anonymous user, email_verified, and tknonce
//   equal to sha256(utf8(publicKey)). Here it only decodes the token, and relies on
//   Turnkey to verify the signature.
// - Rate-limit, per `sub` and per IP. Each call can create a sub-organization.
// - Serialise or lock the find-then-create. It is racy: two concurrent first logins can
//   both create a sub-organization, and `organizationIds[0]` then picks one arbitrarily.
// - Hard-code the `rootUsers` shape (it is hard-coded here, but only because the spike
//   ignores the body; keep it that way and review it like policy).
// - Use an API-only parent key. The spike used the organization's root user key.

const SESSION_SECONDS = "3600"
const PUBLIC_KEY = /^[0-9a-fA-F]{66}$/

// Reads the payload of a JWT without verifying it. That is enough to read the `email`
// claim here: Turnkey verifies the signature (and the nonce) when it uses the token, so a
// forged token fails at createSubOrganization or oauthLogin. It is NOT enough to trust
// any claim for anything else.
function decodePayload(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return payload && typeof payload === "object" ? payload : null
  } catch {
    return null
  }
}

export async function POST(request) {
  try {
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 })
    }
    // Only these two fields are read. `email` and `expirationSeconds` in the body are
    // ignored on purpose, and unknown fields are never forwarded to Turnkey.
    const { oidcToken, publicKey } = body ?? {}
    if (typeof oidcToken !== "string" || oidcToken.length === 0 || oidcToken.length > 8192) {
      return Response.json({ error: "bad_request" }, { status: 400 })
    }
    if (typeof publicKey !== "string" || !PUBLIC_KEY.test(publicKey)) {
      return Response.json({ error: "bad_request" }, { status: 400 })
    }

    const claims = decodePayload(oidcToken)
    if (!claims || typeof claims.email !== "string" || claims.email.length === 0) {
      return Response.json({ error: "invalid_token" }, { status: 401 })
    }
    const userEmail = claims.email

    const parent = parentClient()
    try {
      let ids = await parent.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
      let created = false
      if (!ids.organizationIds?.length) {
        await parent.createSubOrganization({
          subOrganizationName: `spike-${Date.now()}`,
          rootUsers: [{ userName: "spike user", userEmail, apiKeys: [], authenticators: [], oauthProviders: [{ providerName: "supabase", oidcToken }] }],
          rootQuorumThreshold: 1,
          wallet: { walletName: "default", accounts: [{ curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
        })
        created = true
        ids = await parent.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
      }
      const login = await parent.oauthLogin({ organizationId: ids.organizationIds[0], oidcToken, publicKey, expirationSeconds: SESSION_SECONDS })
      return Response.json({ session: login.session, created })
    } catch (error) {
      // The detail stays on the server, without the token. The caller gets nothing to probe.
      const detail = String(error?.message ?? error).split(oidcToken).join("[token]")
      console.error("turnkey-login failed:", detail)
      return Response.json({ error: "login_failed" }, { status: 502 })
    }
  } catch (error) {
    // parentClient() throws here when the parent credentials are missing.
    console.error("turnkey-login failed before reaching Turnkey:", String(error?.message ?? error))
    return Response.json({ error: "login_failed" }, { status: 500 })
  }
}
