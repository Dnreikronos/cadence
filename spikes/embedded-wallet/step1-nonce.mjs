// Can a Supabase access token carry a tknonce that Turnkey will accept?
import { signedInUser, newSessionKey, nonceOf, decodeJwt } from "./lib.mjs"

const { client, session } = await signedInUser("spike@cadence.test")
const before = decodeJwt(session.access_token)
console.log("fresh token claims:", { iss: before.iss, aud: before.aud, hasTknonce: "tknonce" in before })

const key = newSessionKey()
const tknonce = nonceOf.hexText(key.publicKey)
const { error: updateError } = await client.auth.updateUser({ data: { tknonce } })
if (updateError) throw updateError
const { data: refreshed, error: refreshError } = await client.auth.refreshSession()
if (refreshError) throw refreshError
const after = decodeJwt(refreshed.session.access_token)
console.log("refreshed token claims:", { iss: after.iss, aud: after.aud, tknonceMatches: after.tknonce === tknonce })
