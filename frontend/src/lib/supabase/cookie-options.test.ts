import { describe, expect, it } from "vitest"
import {
  capMaxAge,
  cookieOptions,
  isHttps,
  SESSION_MAX_AGE,
  withSessionLifetime,
} from "./cookie-options"

describe("cookieOptions", () => {
  it("is lax, site-wide, secure over https and a week long", () => {
    expect(cookieOptions(true)).toEqual({
      path: "/",
      sameSite: "lax",
      secure: true,
      maxAge: 604_800,
    })
    expect(SESSION_MAX_AGE).toBe(7 * 24 * 60 * 60)
  })

  it("is not secure over plain http, so localhost keeps working", () => {
    expect(cookieOptions(false).secure).toBe(false)
  })

  it("stays readable by the browser client: httpOnly is not set", () => {
    expect(cookieOptions(true)).not.toHaveProperty("httpOnly")
    expect(cookieOptions(false)).not.toHaveProperty("httpOnly")
  })

  it("is far shorter than the library's 400 days", () => {
    expect(cookieOptions(true).maxAge).toBeLessThan(400 * 24 * 60 * 60)
  })
})

describe("capMaxAge", () => {
  it("brings the library's 400 days down to a week", () => {
    expect(capMaxAge({ maxAge: 400 * 24 * 60 * 60 }).maxAge).toBe(604_800)
    expect(capMaxAge({}).maxAge).toBe(604_800)
  })

  it("keeps a shorter lifetime and every other option", () => {
    expect(capMaxAge({ maxAge: 60, path: "/", secure: true })).toEqual({
      maxAge: 60,
      path: "/",
      secure: true,
    })
  })

  it("leaves a deletion a deletion", () => {
    expect(capMaxAge({ maxAge: 0, path: "/" })).toEqual({
      maxAge: 0,
      path: "/",
    })
  })
})

describe("withSessionLifetime", () => {
  it("shortens the cookies that are set and not the ones that are cleared", () => {
    const written = withSessionLifetime([
      { name: "sb-x-auth-token.0", value: "a", options: { maxAge: 34560000 } },
      { name: "sb-x-auth-token.1", value: "", options: { maxAge: 0 } },
    ])
    expect(written.map((c) => [c.name, c.value, c.options.maxAge])).toEqual([
      ["sb-x-auth-token.0", "a", 604_800],
      ["sb-x-auth-token.1", "", 0],
    ])
  })

  it("does not change what it is given", () => {
    const input = [{ name: "n", value: "v", options: { maxAge: 34560000 } }]
    withSessionLifetime(input)
    expect(input[0].options.maxAge).toBe(34560000)
  })
})

describe("isHttps", () => {
  it("reads the page or request protocol", () => {
    expect(isHttps("https:")).toBe(true)
    expect(isHttps("https")).toBe(true)
    expect(isHttps("http:")).toBe(false)
    expect(isHttps(undefined)).toBe(false)
    expect(isHttps(null)).toBe(false)
  })

  it("prefers X-Forwarded-Proto, whose first entry is the client's hop", () => {
    expect(isHttps("http:", "https")).toBe(true)
    expect(isHttps("http:", "https, http")).toBe(true)
    expect(isHttps("https:", "http")).toBe(false)
    expect(isHttps("http:", "HTTPS")).toBe(true)
  })

  it("falls back to the protocol when the header is empty", () => {
    expect(isHttps("https:", "")).toBe(true)
    expect(isHttps("http:", null)).toBe(false)
  })
})
