import { afterEach, describe, expect, it, vi } from "vitest"
import {
  browserCookies,
  parseCookies,
  serializeCookie,
} from "./browser-cookies"

afterEach(() => vi.unstubAllGlobals())

describe("serializeCookie", () => {
  it("writes the session cookie's attributes", () => {
    expect(
      serializeCookie("sb-x-auth-token", "base64-abc", {
        path: "/",
        sameSite: "lax",
        secure: true,
        maxAge: 604_800,
      }),
    ).toBe(
      "sb-x-auth-token=base64-abc; Max-Age=604800; Path=/; Secure; SameSite=Lax",
    )
  })

  it("leaves Secure off when it is not asked for, and encodes the value", () => {
    expect(
      serializeCookie("n", "a b;c=d", { path: "/", sameSite: "lax" }),
    ).toBe("n=a%20b%3Bc%3Dd; Path=/; SameSite=Lax")
  })

  it("writes a deletion with Max-Age=0", () => {
    expect(serializeCookie("n", "", { path: "/", maxAge: 0 })).toBe(
      "n=; Max-Age=0; Path=/",
    )
  })
})

describe("parseCookies", () => {
  it("reads a cookie header, decoding values", () => {
    expect(parseCookies("a=1; sb-x-auth-token.0=base64-q%20z; b=")).toEqual([
      { name: "a", value: "1" },
      { name: "sb-x-auth-token.0", value: "base64-q z" },
      { name: "b", value: "" },
    ])
  })

  it("keeps a value that is not valid encoding as it is, and skips blanks", () => {
    expect(parseCookies("a=%E0%A4%A; ; b=2")).toEqual([
      { name: "a", value: "%E0%A4%A" },
      { name: "b", value: "2" },
    ])
    expect(parseCookies("")).toEqual([])
  })
})

describe("browserCookies", () => {
  it("writes each cookie with the week-long lifetime, whatever the library asked for", () => {
    const written: string[] = []
    vi.stubGlobal("document", {
      get cookie() {
        return "x=1"
      },
      set cookie(value: string) {
        written.push(value)
      },
    })

    browserCookies.setAll([
      {
        name: "sb-x-auth-token",
        value: "v",
        options: {
          path: "/",
          sameSite: "lax",
          secure: true,
          maxAge: 34_560_000,
        },
      },
      {
        name: "sb-x-auth-token.1",
        value: "",
        options: { path: "/", maxAge: 0 },
      },
    ])

    expect(written).toEqual([
      "sb-x-auth-token=v; Max-Age=604800; Path=/; Secure; SameSite=Lax",
      "sb-x-auth-token.1=; Max-Age=0; Path=/",
    ])
    expect(browserCookies.getAll()).toEqual([{ name: "x", value: "1" }])
  })

  it("reads and writes nothing without a document", () => {
    vi.stubGlobal("document", undefined)
    expect(browserCookies.getAll()).toEqual([])
    expect(() =>
      browserCookies.setAll([{ name: "n", value: "v", options: {} }]),
    ).not.toThrow()
  })
})
