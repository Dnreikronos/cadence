// How long a session can live, whether it can be renewed with its own key, and
// whether login accepts an expiry past the 15-minute default.
import { Turnkey } from "@turnkey/sdk-server"
import { signedInUser, newSessionKey, nonceOf, parentTurnkey, decodeJwt } from "./lib.mjs"

const parent = parentTurnkey()
const email = `spike+session-${Date.now()}@cadence.test`
const { client } = await signedInUser(email)

async function freshToken(publicKey) {
  await client.auth.updateUser({ data: { tknonce: nonceOf.hexText(publicKey) } })
  return (await client.auth.refreshSession()).data.session.access_token
}

const first = newSessionKey()
const token0 = await freshToken(first.publicKey)
const sub = await parent.createSubOrganization({
  subOrganizationName: `spike-${Date.now()}`,
  rootUsers: [{ userName: "spike user", userEmail: email, apiKeys: [], authenticators: [], oauthProviders: [{ providerName: "supabase", oidcToken: token0 }] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "default", accounts: [{ curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
})
const subOrgId = sub.subOrganizationId

for (const seconds of ["900", "86400", "604800", "2592000"]) {
  const k = newSessionKey()
  const token = await freshToken(k.publicKey)
  let login
  try {
    const r = await parent.oauthLogin({ organizationId: subOrgId, oidcToken: token, publicKey: k.publicKey, expirationSeconds: seconds })
    login = r
  } catch (e) { console.log(`login with expirationSeconds=${seconds}: refused ->`, String(e.message).slice(0, 110)) }
  if (login) {
    const exp = decodeJwt(login.session).exp
    console.log(`login with expirationSeconds=${seconds}: ok, session lasts ${exp - Math.floor(Date.now() / 1000)} s`)
  }
}

// Renew with the session's own key (what the browser does before it expires).
const k = newSessionKey()
const token = await freshToken(k.publicKey)
await parent.oauthLogin({ organizationId: subOrgId, oidcToken: token, publicKey: k.publicKey, expirationSeconds: "900" })
const session = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: k.publicKey, apiPrivateKey: k.privateKey, defaultOrganizationId: subOrgId }).apiClient()
// Renewal registers a NEW key pair, authorized by a stamp from the live session key.
const next = newSessionKey()
try {
  const r = await session.stampLogin({ publicKey: next.publicKey, expirationSeconds: "900" })
  console.log("stampLogin registering a new key, stamped by the old one: ok, session length:", r.session?.length)
  const renewed = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: next.publicKey, apiPrivateKey: next.privateKey, defaultOrganizationId: subOrgId }).apiClient()
  console.log("renewed key acts:", !!(await renewed.getWhoami()).userId)
  // The old key keeps working until its own expiry unless something revokes it.
  console.log("old key still acts after renewal:", !!(await session.getWhoami().catch(() => null)))
} catch (e) {
  console.log("stampLogin with a new key: FAILED ->", String(e.message).slice(0, 140))
  process.exitCode = 1
}

// A session key that was never logged in must not act.
const stranger = newSessionKey()
const nobody = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: stranger.publicKey, apiPrivateKey: stranger.privateKey, defaultOrganizationId: subOrgId }).apiClient()
let acted = false
try {
  await nobody.getWhoami()
  acted = true
} catch (e) {
  // Only an authorisation refusal counts. A TypeError or a network error proves nothing.
  if (!/not authorized|unauthorized/i.test(String(e?.message))) throw e
  console.log("unregistered session key: refused as intended ->", String(e.message).slice(0, 120))
}
if (acted) {
  console.log("unregistered key acted (bad)")
  process.exitCode = 1
}
