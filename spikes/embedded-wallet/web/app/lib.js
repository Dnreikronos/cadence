// SERVER ONLY. This file reads the parent Turnkey credentials from disk and builds a
// Supabase client with the service role. Import it only from route handlers, never from a
// client component. A real app should add `import "server-only"` here (the `server-only`
// package is not a dependency of this spike, so the build would not enforce it).

import { readFileSync } from "node:fs"
import path from "node:path"
import { Turnkey } from "@turnkey/sdk-server"
import { createClient } from "@supabase/supabase-js"

// The parent credentials live one level up, outside the web app's own env files.
export function parentEnv() {
  return Object.fromEntries(
    readFileSync(path.join(process.cwd(), "..", ".env"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  )
}

export function parentClient() {
  const env = parentEnv()
  return new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID,
  }).apiClient()
}

export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
}
