import { z } from "zod"

export const MOCK_ORIGIN = "http://mock.cadence.test"

const schema = z.object({
  mode: z.enum(["mock", "real"]).optional(),
  baseUrl: z.url().optional(),
})

export type ApiConfig = { mode: "mock" | "real"; baseUrl: string }

type Env = {
  mode?: string
  baseUrl?: string
  isMainnet: boolean
  // process.env.NODE_ENV: "development" under `next dev`.
  nodeEnv?: string
}

// The token and the confidential keys travel in these requests.
const plainHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

// `mock` runs the app against the in-browser mock service so the screens work
// before the Rust service is deployed. It is the default only under `next dev`:
// a preview or production build that forgot the variable must fail, not quietly
// run on fake data. `real` needs the URL, over https unless it is local.
export function readApiConfig(env: Env): ApiConfig {
  const parsed = schema.safeParse({
    mode: env.mode || undefined,
    baseUrl: env.baseUrl || undefined,
  })
  if (!parsed.success) {
    throw new Error(
      `NEXT_PUBLIC_API_MODE must be "mock" or "real" and NEXT_PUBLIC_PROOF_API_URL a URL: ${z.prettifyError(parsed.error)}`,
    )
  }
  const { baseUrl } = parsed.data
  const mode =
    parsed.data.mode ?? (env.nodeEnv === "development" ? "mock" : undefined)
  if (!mode) {
    throw new Error(
      'NEXT_PUBLIC_API_MODE must be set to "mock" or "real" outside development',
    )
  }
  // Fake balances must never reach production.
  if (env.isMainnet && mode === "mock") {
    throw new Error('NEXT_PUBLIC_API_MODE must be "real" on mainnet')
  }
  if (mode === "real") {
    if (!baseUrl) {
      throw new Error(
        'NEXT_PUBLIC_PROOF_API_URL is required when NEXT_PUBLIC_API_MODE is "real"',
      )
    }
    const { protocol, hostname } = new URL(baseUrl)
    const local = protocol === "http:" && plainHttpHosts.has(hostname)
    if (protocol !== "https:" && !local) {
      throw new Error(
        "NEXT_PUBLIC_PROOF_API_URL must use https unless it points at localhost",
      )
    }
    return { mode, baseUrl }
  }
  return { mode, baseUrl: MOCK_ORIGIN }
}
