import { unavailableWallet, type Wallet } from "./types"

// A wallet that fails to load becomes an unavailable one that says why, so the
// provider never stays "loading" for good.
export function settleWallet(loading: Promise<Wallet>): Promise<Wallet> {
  return loading.catch((error: unknown) => {
    const detail = error instanceof Error ? `: ${error.message}` : ""
    return unavailableWallet(`the mock wallet failed to load${detail}`)
  })
}
