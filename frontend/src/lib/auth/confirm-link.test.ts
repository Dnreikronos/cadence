import { describe, expect, it } from "vitest"
import { confirmType, isSameOrigin } from "./confirm-link"

describe("confirmType", () => {
  it.each(["email", "signup"])(
    "accepts the %s link the templates write",
    (type) => {
      expect(confirmType(type)).toBe(type)
    },
  )

  it.each(["recovery", "invite", "magiclink", "email_change", "", "EMAIL"])(
    "rejects %j",
    (type) => {
      expect(confirmType(type)).toBeNull()
    },
  )

  it("rejects an absent value and a file", () => {
    expect(confirmType(null)).toBeNull()
    expect(confirmType(new File([""], "email"))).toBeNull()
  })
})

describe("isSameOrigin", () => {
  const headers = (init: Record<string, string>) => new Headers(init)

  it("accepts a post from the same host", () => {
    expect(
      isSameOrigin(
        headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
      ),
    ).toBe(true)
  })

  it("compares with the public host behind a proxy", () => {
    expect(
      isSameOrigin(
        headers({
          origin: "https://app.cadence.test",
          host: "10.0.0.5:3000",
          "x-forwarded-host": "app.cadence.test",
        }),
      ),
    ).toBe(true)
  })

  it("rejects a post from another site", () => {
    expect(
      isSameOrigin(
        headers({ origin: "https://evil.example", host: "localhost:3000" }),
      ),
    ).toBe(false)
  })

  it("rejects a lookalike host", () => {
    expect(
      isSameOrigin(
        headers({
          origin: "http://localhost:3000.evil.example",
          host: "localhost:3000",
        }),
      ),
    ).toBe(false)
  })

  it.each([
    ["no Origin", { host: "localhost:3000" }],
    ["a null Origin", { origin: "null", host: "localhost:3000" }],
    ["no host", { origin: "http://localhost:3000" }],
  ])("rejects a post with %s", (_, init) => {
    expect(isSameOrigin(headers(init))).toBe(false)
  })
})
