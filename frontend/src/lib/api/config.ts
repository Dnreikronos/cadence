import { z } from "zod"

export const MOCK_ORIGIN = "http://mock.cadence.test"

const schema = z.object({
  mode: z.enum(["mock", "real"]).default("mock"),
  baseUrl: z.url().optional(),
})

export type ApiConfig = { mode: "mock" | "real"; baseUrl: string }

type Env = { mode?: string; baseUrl?: string; isMainnet: boolean }

// `mock` runs the app against the in-browser mock service and is the default, so
// the screens work before the Rust service is deployed. `real` needs the URL.
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
  const { mode, baseUrl } = parsed.data
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
    return { mode, baseUrl }
  }
  return { mode, baseUrl: MOCK_ORIGIN }
}
