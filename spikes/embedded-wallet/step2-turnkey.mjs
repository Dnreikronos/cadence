// Does Turnkey accept the refreshed Supabase token: create a sub-organization from
// it, then log in with it bound to a browser-style session key?
import { signedInUser, newSessionKey, nonceOf, decodeJwt, parentTurnkey } from "./lib.mjs"

const variant = process.argv[2] ?? "hexText"
const email = `spike+${variant}-${Date.now()}@cadence.test`
const turnkey = parentTurnkey()

const { client } = await signedInUser(email)
const key = newSessionKey()
await client.auth.updateUser({ data: { tknonce: nonceOf[variant](key.publicKey) } })
const { data: refreshed } = await client.auth.refreshSession()
const oidcToken = refreshed.session.access_token
const claims = decodeJwt(oidcToken)
console.log("token:", { aud: claims.aud, hasTknonce: !!claims.tknonce, nonceVariant: variant })

try {
  const sub = await turnkey.createSubOrganization({
    subOrganizationName: `spike-${Date.now()}`,
    rootUsers: [
      {
        userName: "spike user",
        userEmail: email,
        apiKeys: [],
        authenticators: [],
        oauthProviders: [{ providerName: "supabase", oidcToken }],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: "default",
      accounts: [
        { curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" },
      ],
    },
  })
  console.log("create sub-organization: ok", { hasSubOrgId: !!sub.subOrganizationId, addresses: sub.wallet?.addresses?.length })

  const ids = await turnkey.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
  console.log("lookup by token:", { found: ids.organizationIds?.length })

  const login = await turnkey.oauthLogin({
    organizationId: ids.organizationIds[0],
    oidcToken,
    publicKey: key.publicKey,
    expirationSeconds: "900",
  })
  console.log("oauth login: ok", { sessionLength: login.session?.length })
} catch (error) {
  console.log("failed:", error?.message ?? error)
  process.exitCode = 1
}
