import { describe, expect, it } from "vitest"
import { ApiError } from "./errors"
import {
  errorActionFor,
  errorDescription,
  isSignedOut,
  signInHref,
} from "./error-action"

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

  it("encodes what would end the value early, so the path comes back whole", () => {
    const href = signInHref("/company/receipts", "?q=a%26b&name=Ana Lima")
    const next = new URL(href, "http://x").searchParams.get("next")
    expect(next).toBe("/company/receipts?q=a%26b&name=Ana Lima")
    expect(href.startsWith("/sign-in?next=%2Fcompany")).toBe(true)
    expect(href).not.toMatch(/[&# ]/)
  })

  it("drops Next's own params and an empty query", () => {
    expect(signInHref("/me", "?_rsc=abc")).toBe("/sign-in?next=%2Fme")
    expect(signInHref("/company")).toBe("/sign-in?next=%2Fcompany")
  })
})

describe("errorDescription", () => {
  it("uses the error's own copy, so a rate limit never says to check the connection", () => {
    expect(errorDescription(new ApiError(429, "rate_limited"))).toBe(
      "Too many requests. Wait a moment and try again.",
    )
    expect(errorDescription(new ApiError(503, "service_unavailable"))).toBe(
      "Cadence is unavailable right now. Try again shortly.",
    )
  })

  it("lets a screen's words about the network apply only to a network failure", () => {
    const networkDescription = "Check your connection and try again."
    expect(
      errorDescription(new ApiError(0, "network_error"), {
        networkDescription,
      }),
    ).toBe(networkDescription)
    // A timeout is not an ApiError either.
    expect(
      errorDescription(new Error("timed out"), { networkDescription }),
    ).toBe(networkDescription)
    expect(
      errorDescription(new ApiError(429, "rate_limited"), {
        networkDescription,
      }),
    ).toBe("Too many requests. Wait a moment and try again.")
    expect(
      errorDescription(new ApiError(401, "authentication_required"), {
        networkDescription,
      }),
    ).toBe("Your session ended. Sign in again to continue.")
  })

  it("uses a screen's wording of a code, and adds what is still true", () => {
    expect(
      errorDescription(new ApiError(404, "run_not_found"), {
        describe: () => "We couldn't find that payroll run.",
        context: "Your people are shown below.",
      }),
    ).toBe("We couldn't find that payroll run. Your people are shown below.")
  })

  it("never tells the reader to try again when no button is offered", () => {
    for (const error of [
      new ApiError(400, "invalid_request"),
      new ApiError(404, "something_new"),
      new ApiError(409, "transaction_failed"),
    ]) {
      expect(errorActionFor(error)).toBe("none")
      expect(errorDescription(error, { context: "Shown below." })).not.toMatch(
        /try again/i,
      )
    }
    expect(errorDescription(new ApiError(400, "invalid_request"))).toBe(
      "Something in the request was wrong.",
    )
    expect(errorDescription(new ApiError(404, "something_new"))).toBe(
      "Something went wrong.",
    )
  })

  it("still says it where a button is offered", () => {
    expect(errorDescription(new ApiError(503, "auth_unavailable"))).toMatch(
      /try again/i,
    )
  })
})
