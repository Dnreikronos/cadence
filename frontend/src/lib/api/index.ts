import { cluster } from "@/lib/solana/cluster"
import { createApiClient } from "./client"
import { readApiConfig } from "./config"

// Read at import so a bad mode fails the build rather than a payment.
// Next inlines NEXT_PUBLIC_* only when referenced literally.
export const apiConfig = readApiConfig({
  mode: process.env.NEXT_PUBLIC_API_MODE,
  baseUrl: process.env.NEXT_PUBLIC_PROOF_API_URL,
  isMainnet: cluster.isMainnet,
})

let mocks: Promise<void> | undefined

// The service worker has to be running before the first request leaves.
async function ready() {
  if (apiConfig.mode !== "mock") return
  if (typeof window === "undefined") {
    throw new Error(
      "The mock API runs in the browser: call it from a client component",
    )
  }
  mocks ??= import("./mocks/browser").then((m) => m.startMockWorker())
  await mocks
}

async function getToken() {
  if (apiConfig.mode === "mock") return "mock-token"
  const { browserSupabase } = await import("@/lib/supabase/browser")
  const { data } = await browserSupabase().auth.getSession()
  return data.session?.access_token ?? null
}

export const api = createApiClient({
  baseUrl: apiConfig.baseUrl,
  getToken,
  fetch: async (input, init) => {
    await ready()
    return fetch(input, init)
  },
})

export { ApiError, ContractError, isApiError, messageFor } from "./errors"
export {
  signAndConfirm,
  ConfirmTimeoutError,
  UnexpectedSignerError,
  type Signer,
  type SignStep,
} from "./sign"
