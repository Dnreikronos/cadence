import { describe, expect, it } from "vitest"
import { emailLinkOrigin, readSiteUrl } from "./site-url"

describe("readSiteUrl", () => {
  it("is the origin of the configured URL, whatever path it carries", () => {
    expect(
      readSiteUrl({
        siteUrl: "https://app.cadence.example/some/path?x=1",
        supabaseConfigured: true,
        nodeEnv: "production",
      }),
    ).toBe("https://app.cadence.example")
  })

  it("is null when unset in development, tests or without Supabase", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(readSiteUrl({ supabaseConfigured: true, nodeEnv })).toBeNull()
    }
    expect(
      readSiteUrl({
        siteUrl: "  ",
        supabaseConfigured: false,
        nodeEnv: "test",
      }),
    ).toBeNull()
    // The demo deploy sends no email.
    expect(
      readSiteUrl({ supabaseConfigured: false, nodeEnv: "production" }),
    ).toBeNull()
  })

  it("fails a production build with Supabase configured and no site URL", () => {
    for (const siteUrl of [undefined, "", "   "]) {
      expect(() =>
        readSiteUrl({
          siteUrl,
          supabaseConfigured: true,
          nodeEnv: "production",
        }),
      ).toThrow(/NEXT_PUBLIC_SITE_URL is required/)
    }
  })

  it("refuses a value that is not a URL", () => {
    expect(() =>
      readSiteUrl({
        siteUrl: "app.example.com",
        supabaseConfigured: true,
        nodeEnv: "production",
      }),
    ).toThrow(/NEXT_PUBLIC_SITE_URL must be a URL/)
  })

  it("requires https unless the host is local", () => {
    expect(() =>
      readSiteUrl({
        siteUrl: "http://app.example.com",
        supabaseConfigured: true,
        nodeEnv: "production",
      }),
    ).toThrow(/must use https/)
    expect(
      readSiteUrl({
        siteUrl: "http://localhost:3000",
        supabaseConfigured: true,
        nodeEnv: "development",
      }),
    ).toBe("http://localhost:3000")
  })
})

describe("emailLinkOrigin", () => {
  it("is the configured site, whatever the request says", () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      expect(
        emailLinkOrigin("https://app.example", "https://evil.example", nodeEnv),
      ).toBe("https://app.example")
    }
  })

  it("falls back to the request's origin outside production", () => {
    expect(emailLinkOrigin(null, "http://localhost:3000", "development")).toBe(
      "http://localhost:3000",
    )
    expect(emailLinkOrigin(null, "http://localhost:3000", "test")).toBe(
      "http://localhost:3000",
    )
    expect(emailLinkOrigin(null, null, "test")).toBeNull()
  })

  it("never trusts the request in production", () => {
    expect(
      emailLinkOrigin(null, "https://evil.example", "production"),
    ).toBeNull()
  })
})
