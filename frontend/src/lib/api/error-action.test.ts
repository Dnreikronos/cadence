import { describe, expect, it } from "vitest"
import { ApiError } from "./errors"
import { errorActionFor, isSignedOut, signInHref } from "./error-action"

describe("errorActionFor", () => {
  it("offers sign-in, not a retry, when the session ended", () => {
    expect(errorActionFor(new ApiError(401, "authentication_required"))).toBe(
      "sign-in",
    )
    // An unknown code on a 401 is still a signed-out answer.
    expect(errorActionFor(new ApiError(401, "something_new"))).toBe("sign-in")
  })

  it.each([
    new ApiError(503, "service_unavailable"),
    new ApiError(503, "auth_unavailable"),
    new ApiError(429, "rate_limited"),
    new ApiError(0, "network_error"),
    new ApiError(500, "internal_error"),
    // A timeout or a response that failed to parse is not an ApiError.
    new Error("timed out"),
  ])("offers a retry for an error that may pass: %s", (error) => {
    expect(errorActionFor(error)).toBe("retry")
  })

  it.each([
    new ApiError(403, "forbidden_role"),
    new ApiError(400, "invalid_request"),
    new ApiError(404, "not_found"),
    new ApiError(409, "transaction_failed"),
  ])("offers nothing for an error that would answer the same: %s", (error) => {
    expect(errorActionFor(error)).toBe("none")
  })
})

describe("isSignedOut", () => {
  it("is only a 401", () => {
    expect(isSignedOut(new ApiError(401, "authentication_required"))).toBe(true)
    expect(isSignedOut(new ApiError(403, "forbidden_role"))).toBe(false)
    expect(isSignedOut(new Error("401"))).toBe(false)
    expect(isSignedOut(undefined)).toBe(false)
  })
})

describe("signInHref", () => {
  it("returns to the current page, filters included", () => {
    expect(signInHref("/company/receipts", "?q=ana&status=failed")).toBe(
      "/sign-in?next=%2Fcompany%2Freceipts%3Fq%3Dana%26status%3Dfailed",
    )
  })

  it("drops Next's own params and an empty query", () => {
    expect(signInHref("/me", "?_rsc=abc")).toBe("/sign-in?next=%2Fme")
    expect(signInHref("/company")).toBe("/sign-in?next=%2Fcompany")
  })
})
