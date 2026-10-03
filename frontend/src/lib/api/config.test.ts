import { describe, expect, it } from "vitest"
import { MOCK_ORIGIN, readApiConfig } from "./config"

const base = { isMainnet: false, nodeEnv: "production" }

describe("readApiConfig", () => {
  it("defaults to mock under next dev", () => {
    expect(readApiConfig({ ...base, nodeEnv: "development" })).toEqual({
      mode: "mock",
      baseUrl: MOCK_ORIGIN,
    })
    expect(
      readApiConfig({ ...base, nodeEnv: "development", mode: "" }),
    ).toEqual({ mode: "mock", baseUrl: MOCK_ORIGIN })
  })

  it.each(["production", "test", undefined])(
    "needs an explicit mode when NODE_ENV is %s",
    (nodeEnv) => {
      expect(() => readApiConfig({ ...base, nodeEnv })).toThrow(
        /NEXT_PUBLIC_API_MODE/,
      )
      expect(() => readApiConfig({ ...base, nodeEnv, mode: "" })).toThrow(
        /NEXT_PUBLIC_API_MODE/,
      )
    },
  )

  it("allows an explicit mock off mainnet, in any environment", () => {
    expect(readApiConfig({ ...base, mode: "mock" })).toEqual({
      mode: "mock",
      baseUrl: MOCK_ORIGIN,
    })
  })

  it("refuses mock on mainnet, even under next dev", () => {
    for (const nodeEnv of ["production", "development"]) {
      expect(() =>
        readApiConfig({ isMainnet: true, nodeEnv, mode: "mock" }),
      ).toThrow(/real/)
    }
    expect(() =>
      readApiConfig({ isMainnet: true, nodeEnv: "development" }),
    ).toThrow(/real/)
  })

  it("takes real with an https URL, on mainnet too", () => {
    expect(
      readApiConfig({
        isMainnet: true,
        nodeEnv: "production",
        mode: "real",
        baseUrl: "https://api.cadence.test",
      }),
    ).toEqual({ mode: "real", baseUrl: "https://api.cadence.test" })
  })

  it("needs a URL for real", () => {
    expect(() => readApiConfig({ ...base, mode: "real" })).toThrow(
      /NEXT_PUBLIC_PROOF_API_URL/,
    )
  })

  it("refuses an unknown mode and a malformed URL", () => {
    expect(() => readApiConfig({ ...base, mode: "fake" })).toThrow(
      /NEXT_PUBLIC_API_MODE/,
    )
    expect(() =>
      readApiConfig({ ...base, mode: "real", baseUrl: "not a url" }),
    ).toThrow(/NEXT_PUBLIC_PROOF_API_URL/)
  })

  it.each([
    "http://api.cadence.test",
    "http://192.168.1.20:8080",
    "http://localhost.evil.test",
    "ws://localhost:8080",
  ])(
    "refuses %s, because the token and keys travel in the requests",
    (baseUrl) => {
      expect(() => readApiConfig({ ...base, mode: "real", baseUrl })).toThrow(
        /https/,
      )
    },
  )

  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://api.cadence.test",
  ])("accepts %s", (baseUrl) => {
    expect(readApiConfig({ ...base, mode: "real", baseUrl })).toEqual({
      mode: "real",
      baseUrl,
    })
  })
})
