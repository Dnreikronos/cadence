import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { headerRules } from "./security-headers"

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

const forPath = (path: string) =>
  Object.fromEntries(
    headerRules()
      .filter(({ source }) => matches(source, path))
      .flatMap(({ headers }) => headers.map(({ key, value }) => [key, value])),
  )

describe("headerRules", () => {
  it.each(["/", "/sign-in", "/company/people", "/auth/confirm"])(
    "refuses framing on %s",
    (path) => {
      expect(forPath(path)["Content-Security-Policy"]).toBe(
        "frame-ancestors 'none'",
      )
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
    expect(forPath(path)["Content-Security-Policy"]).toBe(
      "frame-ancestors 'self'",
    )
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
      expect(forPath(path)["Content-Security-Policy"]).toBe(
        "frame-ancestors 'none'",
      )
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
})
