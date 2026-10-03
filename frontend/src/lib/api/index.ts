import { createApiClient } from "./client"
import { apiConfig } from "./mode"

export { apiConfig }

let mocks: Promise<void> | undefined

// The service worker has to be running before the first request leaves. The
// literal check on the mode lets Next inline it, so a real-mode build drops the
// import and the mock worker never reaches the client bundle.
export async function whenApiReady() {
  if (
    process.env.NEXT_PUBLIC_API_MODE !== "real" &&
    apiConfig.mode === "mock"
  ) {
    if (typeof window === "undefined") {
      throw new Error(
        "The mock API runs in the browser: call it from a client component",
      )
    }
    // A failed start is dropped, so the next call can try again.
    mocks ??= import("./mocks/browser")
      .then((m) => m.startMockWorker())
      .catch((error: unknown) => {
        mocks = undefined
        throw error
      })
    await mocks
  }
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
    await whenApiReady()
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
