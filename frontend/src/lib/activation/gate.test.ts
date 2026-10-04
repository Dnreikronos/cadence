import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { AccountStatus } from "@/lib/api/schemas"
import { canRetryStatus, statusMessage } from "./errors"
import { gateView } from "./gate"

const done: AccountStatus = {
  wallet_linked: true,
  key_enrolled: true,
  account_configured: true,
  pending_credits: false,
}

describe("gateView", () => {
  it("shows the page only for a set-up account, and sends the rest to setup", () => {
    expect(gateView({ data: done, isError: false })).toBe("ready")
    expect(
      gateView({ data: { ...done, key_enrolled: false }, isError: false }),
    ).toBe("redirect")
  })

  it("waits while there is nothing to go on, and fails closed on a first failed read", () => {
    expect(gateView({ isError: false })).toBe("loading")
    expect(gateView({ isError: true })).toBe("error")
  })

  it("does not lock out someone whose status was read once, when a later read fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let reads = 0
    const observer = new QueryObserver(client, {
      queryKey: ["status"],
      queryFn: async () => {
        reads += 1
        if (reads > 1) throw new ApiError(503, "auth_unavailable")
        return done
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    await observer.refetch()
    await observer.refetch()

    const result = observer.getCurrentResult()
    // The refetch failed and React Query kept the data from the first read.
    expect(result.isError).toBe(true)
    expect(result.data).toEqual(done)
    expect(gateView(result)).toBe("ready")
    unsubscribe()
  })

  it("fails closed when the very first read fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const observer = new QueryObserver(client, {
      queryKey: ["status"],
      queryFn: async () => {
        throw new ApiError(503, "auth_unavailable")
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    await observer.refetch()
    expect(gateView(observer.getCurrentResult())).toBe("error")
    unsubscribe()
  })
})

describe("when the status cannot be read", () => {
  it("tells a lapsed session to sign in again, with nothing to retry", () => {
    const error = new ApiError(401, "authentication_required")
    expect(statusMessage(error)).toBe(
      "Your session ended. Sign in again to continue.",
    )
    expect(canRetryStatus(error)).toBe(false)
  })

  it("says setup is not available for a 404, with nothing to retry", () => {
    const error = new ApiError(404, "not_found")
    expect(statusMessage(error)).toBe(
      "Account setup isn't available right now.",
    )
    expect(canRetryStatus(error)).toBe(false)
  })

  it("lets a busy or failed service be retried, with its usual copy", () => {
    const error = new ApiError(503, "auth_unavailable")
    expect(canRetryStatus(error)).toBe(true)
    expect(canRetryStatus(new Error("offline"))).toBe(true)
    expect(statusMessage(error)).toBe(
      "Cadence can't check your session right now. Try again shortly.",
    )
  })
})
