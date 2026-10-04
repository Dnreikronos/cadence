// With a user-bound session: sign a v1 transaction and a message, sign 20 times in
// a row, and prove the parent organization (our API key) cannot sign for the user.
import { readFileSync } from "node:fs"
import { Turnkey } from "@turnkey/sdk-server"
import bs58 from "bs58"
import { ed25519 } from "@noble/curves/ed25519.js"
import { signedInUser, newSessionKey, nonceOf, parentTurnkey, loadEnv } from "./lib.mjs"

const env = loadEnv()
const parent = parentTurnkey(env)
const email = `spike+sign-${Date.now()}@cadence.test`
const { client } = await signedInUser(email)
const key = newSessionKey()
await client.auth.updateUser({ data: { tknonce: nonceOf.hexText(key.publicKey) } })
const oidcToken = (await client.auth.refreshSession()).data.session.access_token

const sub = await parent.createSubOrganization({
  subOrganizationName: `spike-${Date.now()}`,
  rootUsers: [{ userName: "spike user", userEmail: email, apiKeys: [], authenticators: [], oauthProviders: [{ providerName: "supabase", oidcToken }] }],
  rootQuorumThreshold: 1,
  wallet: { walletName: "default", accounts: [{ curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
})
const subOrgId = sub.subOrganizationId
const address = sub.wallet.addresses[0]
console.log("sub-organization ready, wallet address length:", address.length)

// ---- The session: log in, then act as the user with the session key.
const ids = await parent.getSubOrgIds({ filterType: "OIDC_TOKEN", filterValue: oidcToken })
await parent.oauthLogin({ organizationId: ids.organizationIds[0], oidcToken, publicKey: key.publicKey, expirationSeconds: "900" })

// ---- Who is in the sub-organization, after the login (the login registers the session key
// on the user as an API key, so this is where a parent-key credential would show up).
{
  const { users = [] } = await parent.getUsers({ organizationId: subOrgId })
  const apiKeys = (users[0]?.apiKeys ?? []).length
  const parentHasKey = users.some((u) => (u.apiKeys ?? []).some((k) => k.credential?.publicKey === env.TURNKEY_API_PUBLIC_KEY))
  console.log("sub-org users:", users.length, "| oauth providers on the user:", users[0]?.oauthProviders?.length, "| api keys on the user:", apiKeys, "| any equals the parent public key:", parentHasKey)
}
const session = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, defaultOrganizationId: subOrgId }).apiClient()
const who = await session.getWhoami()
console.log("session whoami:", { userName: who.username, isSubOrg: who.organizationId === subOrgId })

// ---- A v1 transaction: the earlier spike's synthetic confidential transfer, with its
// signer swapped for this wallet so the key the session controls is a required signer.
const fixture = JSON.parse(readFileSync(new URL("../wallet-providers/fixture.json", import.meta.url), "utf8"))
const wire = Buffer.from(fixture.transaction, "base64")
const from = Buffer.from(bs58.decode(fixture.address)), to = Buffer.from(bs58.decode(address))
let swapped = 0
for (let i = wire.indexOf(from); i !== -1; i = wire.indexOf(from, i + 32)) { to.copy(wire, i); swapped++ }
console.log("transaction:", { bytes: wire.length, versionByte: wire[0], signerSwaps: swapped })

async function signTx(client, organizationId) {
  const r = await client.signTransaction({ organizationId, signWith: address, unsignedTransaction: wire.toString("hex"), type: "TRANSACTION_TYPE_SOLANA" })
  if (r.activity.status !== "ACTIVITY_STATUS_COMPLETED" || !r.signedTransaction) throw new Error(r.activity.status)
  return Buffer.from(r.signedTransaction, "hex")
}
try {
  const signed = await signTx(session, subOrgId)
  console.log("session signs the v1 transaction: ok", { bytes: signed.length, changed: !signed.equals(wire) })
} catch (e) { console.log("session signs the v1 transaction: FAILED", e.message) }

// ---- The parent organization must not be able to sign for the user.
try {
  await signTx(parent, subOrgId)
  console.log("PARENT CAN SIGN FOR THE USER (bad)")
} catch (e) {
  // Only an authorisation refusal counts. A TypeError or a network error proves nothing.
  if (!/not authorized/i.test(String(e?.message))) throw e
  console.log("parent signing for the user: refused as intended ->", String(e.message).slice(0, 140))
}

// ---- signMessage: what Phantom rejects. Signs bytes and verifies against the address.
try {
  const message = Buffer.from("Cadence key derivation spike message")
  const r = await session.signRawPayload({ signWith: address, payload: message.toString("hex"), encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NOT_APPLICABLE" })
  const sig = Buffer.from(r.r + r.s, "hex")
  console.log("session signs a message: ok", { signatureBytes: sig.length, verifies: ed25519.verify(sig, message, bs58.decode(address)) })
} catch (e) { console.log("session signs a message: FAILED", e.message) }

// ---- 20 signatures in a row inside one session.
const started = Date.now(), times = []
let failed = 0
for (let i = 0; i < 20; i++) {
  const t = Date.now()
  try { await signTx(session, subOrgId) } catch (e) { failed++; if (failed === 1) console.log("first failure at", i, String(e.message).slice(0, 120)) }
  times.push(Date.now() - t)
}
times.sort((a, b) => a - b)
console.log("20 signatures:", { failed, totalMs: Date.now() - started, medianMs: times[10], maxMs: times[19] })
