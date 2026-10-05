import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import {
  connectSources,
  contentSecurityPolicy,
  headerRules,
  type HeaderOptions,
} from "./security-headers"

// Next's own copy of path-to-regexp ships no types.
const { pathToRegexp } = createRequire(import.meta.url)(
  "next/dist/compiled/path-to-regexp",
) as {
  pathToRegexp: (
    source: string,
    keys: unknown[],
    options: { delimiter: string; sensitive: boolean; strict: boolean },
  ) => RegExp
}

// Next matches a `headers()` source with its own copy of path-to-regexp (delimiter "/",
// case-insensitive, a trailing slash optional), and applies every rule that matches, a
// later one overriding an earlier one for the same header. Doing the same here means the
// tests read the rules the way the server does, `:path*` and bare `/dev` included.
const matches = (source: string, path: string) =>
  pathToRegexp(source, [], {
    delimiter: "/",
    sensitive: false,
    strict: false,
  }).test(path)

const forPath = (path: string, options?: HeaderOptions) =>
  Object.fromEntries(
    headerRules(options)
      .filter(({ source }) => matches(source, path))
      .flatMap(({ headers }) => headers.map(({ key, value }) => [key, value])),
  )

// One directive of the policy served for a path, exactly as written (undefined if absent).
const directive = (path: string, name: string, options?: HeaderOptions) =>
  forPath(path, options)
    ["Content-Security-Policy"].split("; ")
    .find((part) => part === name || part.startsWith(`${name} `))
    ?.slice(name.length + 1)

const real = {
  apiBaseUrl: "https://api.cadence.example/v1",
  supabaseUrl: "https://abc.supabase.co",
  rpcUrl: "https://rpc.example.com/key",
}

describe("headerRules", () => {
  it.each(["/", "/sign-in", "/company/people", "/auth/confirm"])(
    "refuses framing on %s",
    (path) => {
      expect(directive(path, "frame-ancestors")).toBe("'none'")
      expect(forPath(path)["X-Frame-Options"]).toBe("DENY")
    },
  )

  it.each([
    "/dev",
    "/dev/",
    "/dev/components",
    "/dev/components/shell/admin",
    "/dev/api",
  ])("lets %s be framed by its own origin only", (path) => {
    expect(directive(path, "frame-ancestors")).toBe("'self'")
    expect(forPath(path)["X-Frame-Options"]).toBe("SAMEORIGIN")
  })

  it("keeps the dev exception out of every other path, including look-alikes", () => {
    for (const path of [
      "/developers",
      "/devices",
      "/company/dev/x",
      "/dev-tools-are-off",
      "/sign-in",
    ]) {
      expect(directive(path, "frame-ancestors")).toBe("'none'")
      expect(forPath(path)["X-Frame-Options"]).toBe("DENY")
    }
  })

  it("puts the dev rule after the global one, which is what lets it win", () => {
    const sources = headerRules().map(({ source }) => source)
    expect(sources.indexOf("/dev/:path*")).toBeGreaterThan(
      sources.indexOf("/:path*"),
    )
  })

  it("keeps the confirm page out of every cache, and only that page here", () => {
    expect(forPath("/auth/confirm")["Cache-Control"]).toBe("no-store")
    expect(forPath("/sign-in")["Cache-Control"]).toBeUndefined()
  })

  it.each(["/", "/sign-in", "/auth/confirm", "/company", "/dev/api"])(
    "sends the same hardening headers on %s",
    (path) => {
      const headers = forPath(path)
      // Not "no-referrer": it makes Chrome send `Origin: null` with a form POST.
      expect(headers["Referrer-Policy"]).toBe("same-origin")
      expect(headers["X-Content-Type-Options"]).toBe("nosniff")
      expect(headers["Permissions-Policy"]).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      )
    },
  )

  it("sends HSTS in a production build only", () => {
    expect(forPath("/")["Strict-Transport-Security"]).toBeUndefined()
    expect(
      forPath("/", { production: true })["Strict-Transport-Security"],
    ).toBe("max-age=63072000; includeSubDomains")
    expect(
      forPath("/dev/api", { production: true })["Strict-Transport-Security"],
    ).toBe("max-age=63072000; includeSubDomains")
  })

  it("restricts only framing under `next dev`, whose refresh runtime needs eval", () => {
    expect(forPath("/", { development: true })["Content-Security-Policy"]).toBe(
      "frame-ancestors 'none'",
    )
    expect(
      forPath("/dev/api", { development: true })["Content-Security-Policy"],
    ).toBe("frame-ancestors 'self'")
  })
})

describe("contentSecurityPolicy", () => {
  it("is the stage 1 policy, directive by directive", () => {
    const connect = ["'self'", "https://a.example"]
    expect(contentSecurityPolicy(connect, "'none'").split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' https://a.example",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ])
  })

  it("never allows eval, or a script from anywhere else", () => {
    const policy = contentSecurityPolicy(connectSources({ ...real }), "'none'")
    expect(policy).not.toContain("unsafe-eval")
    expect(policy).not.toMatch(/script-src[^;]*https?:/)
    expect(policy).not.toContain("*")
  })

  it("serves the full policy on every path, the dev pages with their own framing", () => {
    expect(directive("/sign-in", "script-src")).toBe("'self' 'unsafe-inline'")
    expect(directive("/dev/api", "script-src")).toBe("'self' 'unsafe-inline'")
    expect(directive("/dev/api", "object-src")).toBe("'none'")
  })

  it("carries the connect-src it is given on every path", () => {
    const connect = connectSources({ ...real })
    const options = { connect }
    expect(directive("/", "connect-src", options)).toBe(connect.join(" "))
    expect(directive("/dev/api", "connect-src", options)).toBe(
      connect.join(" "),
    )
  })
})

describe("connectSources", () => {
  it("names the service, Supabase, Turnkey and the RPC, as origins", () => {
    expect(connectSources(real)).toEqual([
      "'self'",
      "https://api.cadence.example",
      "https://abc.supabase.co",
      "https://api.turnkey.com",
      "https://rpc.example.com",
    ])
  })

  it("names the mock origin in mock mode, where the base URL is the mock's", () => {
    expect(
      connectSources({
        apiBaseUrl: "http://mock.cadence.test",
        rpcUrl: "https://api.devnet.solana.com",
      }),
    ).toEqual([
      "'self'",
      "http://mock.cadence.test",
      "https://api.turnkey.com",
      "https://api.devnet.solana.com",
    ])
  })

  it("leaves Supabase out when it is not configured or not a URL", () => {
    for (const supabaseUrl of [undefined, "", "not a url"]) {
      expect(connectSources({ ...real, supabaseUrl })).not.toContain(
        "https://abc.supabase.co",
      )
      expect(connectSources({ ...real, supabaseUrl })).toHaveLength(4)
    }
  })

  it("lists an origin once", () => {
    const sources = connectSources({
      apiBaseUrl: "https://x.example/a",
      supabaseUrl: "https://x.example",
      rpcUrl: "https://x.example/rpc",
    })
    expect(sources.filter((s) => s === "https://x.example")).toHaveLength(1)
  })
})
