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

  it("accepts a post from the same scheme, host and port", () => {
    expect(
      isSameOrigin(
        headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
        "http:",
      ),
    ).toBe(true)
  })

  it("treats the default port as implied", () => {
    expect(
      isSameOrigin(
        headers({ origin: "https://app.test", host: "app.test:443" }),
        "https:",
      ),
    ).toBe(true)
    expect(
      isSameOrigin(
        headers({ origin: "https://app.test:443", host: "app.test" }),
        "https:",
      ),
    ).toBe(true)
  })

  it("compares with the public host and scheme behind a proxy", () => {
    expect(
      isSameOrigin(
        headers({
          origin: "https://app.cadence.test",
          host: "10.0.0.5:3000",
          "x-forwarded-host": "app.cadence.test",
          "x-forwarded-proto": "https",
        }),
        "http:",
      ),
    ).toBe(true)
  })

  it("rejects a post from another site", () => {
    expect(
      isSameOrigin(
        headers({ origin: "https://evil.example", host: "localhost:3000" }),
        "https:",
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
        "http:",
      ),
    ).toBe(false)
  })

  it("rejects the same hostname on another port", () => {
    expect(
      isSameOrigin(
        headers({ origin: "http://app.test:8080", host: "app.test:3000" }),
        "http:",
      ),
    ).toBe(false)
    expect(
      isSameOrigin(
        headers({ origin: "http://app.test:3000", host: "app.test" }),
        "http:",
      ),
    ).toBe(false)
  })

  it("rejects the same host on another scheme", () => {
    expect(
      isSameOrigin(
        headers({ origin: "http://app.test", host: "app.test" }),
        "https:",
      ),
    ).toBe(false)
    expect(
      isSameOrigin(
        headers({
          origin: "http://app.test",
          host: "app.test",
          "x-forwarded-proto": "https",
        }),
        "http:",
      ),
    ).toBe(false)
  })

  it("uses only the first value of a multi-valued forwarded header", () => {
    const forwarded = {
      host: "10.0.0.5:3000",
      "x-forwarded-host": "app.test, internal.test",
      "x-forwarded-proto": "https, http",
    }
    expect(
      isSameOrigin(
        headers({ origin: "https://app.test", ...forwarded }),
        "http:",
      ),
    ).toBe(true)
    // The value a later proxy appended must not be the one trusted.
    expect(
      isSameOrigin(
        headers({ origin: "https://internal.test", ...forwarded }),
        "http:",
      ),
    ).toBe(false)
  })

  it.each([
    ["no Origin", { host: "localhost:3000" }],
    ["a null Origin", { origin: "null", host: "localhost:3000" }],
    [
      "an Origin that is no URL",
      { origin: "not a url", host: "localhost:3000" },
    ],
    ["no host", { origin: "http://localhost:3000" }],
  ])("rejects a post with %s", (_, init) => {
    expect(isSameOrigin(headers(init), "http:")).toBe(false)
  })
})
