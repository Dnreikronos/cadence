import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createClient } from "@supabase/supabase-js"
import { Turnkey } from "@turnkey/sdk-server"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { createECDH } from "node:crypto"

export function loadEnv() {
  return Object.fromEntries(
    readFileSync(new URL("./.env", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  )
}

// The tunnel URL the auth server uses as its issuer, from supabase/config.toml.
export function issuerBase() {
  const toml = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8")
  const match = toml.match(/^external_url = "(.*)\/auth\/v1"/m)
  if (!match) {
    throw new Error('supabase/config.toml has no uncommented `external_url = "https://<tunnel>/auth/v1"` under [auth]; see the README, step 3')
  }
  return match[1]
}

// Pinned so a spike run does not execute whatever `supabase` is newest on npm.
export const SUPABASE_CLI_VERSION = "2.119.0"

export function localKeys() {
  const out = execFileSync("pnpm", ["dlx", `supabase@${SUPABASE_CLI_VERSION}`, "status", "-o", "env"], {
    cwd: new URL("../..", import.meta.url).pathname,
    encoding: "utf8",
  })
  const get = (k) => out.match(new RegExp(`^${k}="?([^"\\n]*)"?$`, "m"))?.[1]
  return { publishable: get("PUBLISHABLE_KEY") ?? get("ANON_KEY"), secret: get("SECRET_KEY") ?? get("SERVICE_ROLE_KEY") }
}

export function parentTurnkey(env = loadEnv()) {
  return new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID,
  }).apiClient()
}

// A fresh P-256 key pair for the browser-side Turnkey session.
export function newSessionKey() {
  const e = createECDH("prime256v1")
  e.generateKeys()
  return { publicKey: e.getPublicKey("hex", "compressed"), privateKey: e.getPrivateKey("hex").padStart(64, "0") }
}

// Two readings of "sha256(publicKey)": over the hex text, or over the key bytes.
export const nonceOf = {
  hexText: (publicKey) => bytesToHex(sha256(utf8ToBytes(publicKey))),
  bytes: (publicKey) => bytesToHex(sha256(hexToBytes(publicKey))),
}

export function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
}

export async function signedInUser(email) {
  const { publishable, secret } = localKeys()
  const url = issuerBase()
  const admin = createClient(url, secret, { auth: { persistSession: false } })
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email })
  if (linkError) throw linkError
  const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: link.properties.verification_type })
  if (error) throw error
  return { client, session: data.session }
}
