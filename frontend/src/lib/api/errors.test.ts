import { describe, expect, it } from "vitest"
import { ApiError, errorFromResponse, messageFor } from "./errors"

const generic = "Something went wrong. Try again."

describe("isRetryable", () => {
  it.each([
    [409, "transaction_not_finalized"],
    [429, "rate_limited"],
    [429, "wrap_rate_limited"],
    [502, "service_unavailable"],
    [503, "rpc_unavailable"],
    [503, "auth_unavailable"],
    [504, "service_unavailable"],
    [0, "network_error"],
  ])("%i %s may succeed later", (status, code) => {
    expect(new ApiError(status, code).isRetryable).toBe(true)
  })

  it.each([
    [400, "invalid_request"],
    [401, "authentication_required"],
    [403, "forbidden_role"],
    [404, "not_found"],
    [409, "transaction_failed"],
    [500, "internal_error"],
  ])("%i %s is final", (status, code) => {
    expect(new ApiError(status, code).isRetryable).toBe(false)
  })
})

describe("messageFor", () => {
  const newCodes = [
    "insufficient_usdc",
    "wrap_already_confirmed",
    "invalid_wallet",
    "invalid_account",
    "invalid_balance_key",
    "invalid_signature",
    "invalid_transfer",
    "invalid_confidential_setup",
    "wrap_requires_devnet",
    "wrapped_mint_missing",
    "usdc_source_missing",
    "confidential_destination_unavailable",
  ]

  it.each(newCodes)("has its own copy for %s", (code) => {
    const message = messageFor(new ApiError(409, code))
    expect(message).not.toBe(generic)
    expect(message).not.toMatch(/unavailable right now/)
    // Plain copy: short, and never a value or the code itself.
    expect(message.length).toBeLessThan(70)
    expect(message).not.toMatch(/\d|_/)
  })

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "does not resolve the inherited member %s",
    (code) => {
      expect(messageFor(new ApiError(409, code))).toBe(generic)
      expect(messageFor(new ApiError(503, code))).toBe(
        "Cadence is unavailable right now. Try again shortly.",
      )
    },
  )

  it("falls back by status for an unknown code, and for a non-ApiError", () => {
    expect(messageFor(new ApiError(409, "brand_new_code"))).toBe(generic)
    expect(messageFor(new ApiError(500, "brand_new_code"))).toMatch(
      /unavailable/,
    )
    expect(messageFor(new Error("boom"))).toBe(generic)
  })
})

describe("errorFromResponse", () => {
  it("reads only the code and Retry-After", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "retry-after": "12" },
    })
    const error = errorFromResponse(response, {
      error: "wrap_rate_limited",
      amount: "5",
    })
    expect(error).toMatchObject({
      status: 429,
      code: "wrap_rate_limited",
      retryAfter: 12,
    })
    expect(JSON.stringify(error)).not.toContain("5")
  })

  it("falls back to the status class when the body is not an error", () => {
    expect(
      errorFromResponse(new Response(null, { status: 502 }), "<html>"),
    ).toMatchObject({ status: 502, code: "service_unavailable" })
  })
})
