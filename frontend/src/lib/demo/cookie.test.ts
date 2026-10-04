import { describe, expect, it } from "vitest"
import { isHttpsRequest } from "./cookie"

const request = (headers: Record<string, string>) =>
  isHttpsRequest(new Headers(headers))

describe("isHttpsRequest", () => {
  it("trusts the proxy's protocol first", () => {
    expect(request({ "x-forwarded-proto": "https" })).toBe(true)
    expect(request({ "x-forwarded-proto": "HTTPS" })).toBe(true)
    expect(request({ "x-forwarded-proto": "http" })).toBe(false)
    expect(
      request({
        "x-forwarded-proto": "http",
        origin: "https://preview.example.test",
      }),
    ).toBe(false)
  })

  it("uses the first hop of a forwarded chain", () => {
    expect(request({ "x-forwarded-proto": "https, http" })).toBe(true)
    expect(request({ "x-forwarded-proto": "http, https" })).toBe(false)
  })

  it("falls back to the Origin of the post", () => {
    expect(request({ origin: "https://preview.example.test" })).toBe(true)
    expect(request({ origin: "http://192.168.0.5:3000" })).toBe(false)
  })

  it("is not https when nothing says so", () => {
    expect(request({})).toBe(false)
  })
})
