// Read-only check that the API key works: asks Turnkey who the key belongs to.
import { readFileSync } from "node:fs"
import { Turnkey } from "@turnkey/sdk-server"

const env = Object.fromEntries(
  readFileSync(new URL("./.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
)

const turnkey = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
  apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
  defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID,
})

const client = turnkey.apiClient()
try {
  const who = await client.getWhoami()
  // Names only: the organization and user ids are not secrets, but keep the output short.
  console.log("ok:", { organizationName: who.organizationName, username: who.username, sameOrg: who.organizationId === env.TURNKEY_ORGANIZATION_ID })
} catch (error) {
  console.log("failed:", error?.message ?? error)
}
