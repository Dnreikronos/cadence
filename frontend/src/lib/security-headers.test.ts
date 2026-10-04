import { describe, expect, it } from "vitest"
import { headerRules } from "./security-headers"

const forPath = (path: string) =>
  Object.fromEntries(
    headerRules()
      // Next's path-to-regexp: "/:path*" covers every path, a plain path only itself.
      .filter(({ source }) => source === "/:path*" || source === path)
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

  it("keeps the confirm page out of every cache, and only that page here", () => {
    expect(forPath("/auth/confirm")["Cache-Control"]).toBe("no-store")
    expect(forPath("/sign-in")["Cache-Control"]).toBeUndefined()
  })
})
