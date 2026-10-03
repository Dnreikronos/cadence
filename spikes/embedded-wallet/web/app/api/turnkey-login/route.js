import { parentClient } from "../../lib"

// What #78 will become: the browser sends its Supabase access token (carrying the
// tknonce for the key it just generated) and that key's public half. This route holds
// the parent API key, which can create sub-organizations and log users in but cannot sign.
export async function POST(request) {
  const { oidcToken, publicKey, email, expirationSeconds = "3600" } = await request.json()
  const parent = parentClient()
  try {
    let ids = await parent.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
    let created = false
    if (!ids.organizationIds?.length) {
      await parent.createSubOrganization({
        subOrganizationName: `spike-${Date.now()}`,
        rootUsers: [{ userName: "spike user", userEmail: email, apiKeys: [], authenticators: [], oauthProviders: [{ providerName: "supabase", oidcToken }] }],
        rootQuorumThreshold: 1,
        wallet: { walletName: "default", accounts: [{ curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
      })
      created = true
      ids = await parent.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
    }
    const login = await parent.oauthLogin({ organizationId: ids.organizationIds[0], oidcToken, publicKey, expirationSeconds })
    return Response.json({ session: login.session, created })
  } catch (error) {
    return Response.json({ error: String(error.message ?? error) }, { status: 500 })
  }
}
