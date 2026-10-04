import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { makeQueryClient, shouldRetry } from "./client"

describe("shouldRetry", () => {
  it("retries once on a server error, a lost connection or an unknown error", () => {
    for (const error of [
      new ApiError(503, "service_unavailable"),
      new ApiError(0, "network_error"),
      new Error("boom"),
    ]) {
      expect(shouldRetry(0, error)).toBe(true)
      expect(shouldRetry(1, error)).toBe(false)
    }
  })

  it.each([400, 401, 403, 404, 409, 429, 499])(
    "never retries a %d",
    (status) => {
      expect(shouldRetry(0, new ApiError(status, "request_failed"))).toBe(false)
    },
  )
})

describe("makeQueryClient", () => {
  it("sets the shared query defaults", () => {
    const { queries } = makeQueryClient().getDefaultOptions()
    expect(queries).toMatchObject({
      staleTime: 30_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
    })
  })

  it("makes a fresh client each time", () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient())
  })
})
