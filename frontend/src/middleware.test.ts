import { NextRequest, NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  broken: false,
  mode: "mock",
  supabaseConfigured: false,
  isMainnet: false,
}))
const createMiddlewareClient = vi.hoisted(() => vi.fn())
const getUser = vi.hoisted(() => vi.fn())
const signOut = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      if (config.broken) throw new Error("NEXT_PUBLIC_API_MODE must be set")
      return config.mode
    },
  },
}))
vi.mock("@/lib/solana/cluster", () => ({
  cluster: {
    get isMainnet() {
      if (config.broken) throw new Error("bad cluster")
      return config.isMainnet
    },
  },
}))
vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => config.supabaseConfigured,
}))
vi.mock("@/lib/supabase/middleware", () => ({ createMiddlewareClient }))
vi.mock("@/lib/supabase/membership", () => ({ membershipOf: vi.fn() }))

import { membershipOf } from "@/lib/supabase/membership"
import { middleware } from "./middleware"

const COOKIE = "cadence-demo-role"

function visit(path: string, role?: string) {
  const request = new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: role === undefined ? {} : { cookie: `${COOKIE}=${role}` },
  })
  return middleware(request)
}

function outcome(response: NextResponse) {
  const to = response.headers.get("location")
  return to ? new URL(to).pathname + new URL(to).search : "next"
}

afterEach(() => vi.unstubAllEnvs())

beforeEach(() => {
  Object.assign(config, {
    broken: false,
    mode: "mock",
    supabaseConfigured: false,
    isMainnet: false,
  })
  createMiddlewareClient.mockReset()
  getUser.mockReset()
  signOut.mockReset().mockResolvedValue({ error: null })
  vi.mocked(membershipOf).mockReset()
  // Supabase configured: a visitor with no session.
  getUser.mockResolvedValue({ data: { user: null } })
  createMiddlewareClient.mockImplementation(() => ({
    supabase: { auth: { getUser, signOut } },
    response: () => NextResponse.next(),
    cacheHeaders: {},
  }))
})

describe("the /dev pages", () => {
  const status = (response: NextResponse) => response.status
  const rewritten = (response: NextResponse) =>
    response.headers.get("x-middleware-rewrite")

  it.each([
    "/dev",
    "/dev/",
    "/dev/api",
    "/dev/components",
    "/%64ev",
    "/DEV/api",
  ])(
    "answers 404 for %s in a production build without the flag, with or without a session",
    async (path) => {
      vi.stubEnv("NODE_ENV", "production")
      for (const role of [undefined, "admin"]) {
        const response = await visit(path, role)
        expect(status(response)).toBe(404)
        expect(rewritten(response)).toContain("/dev-tools-are-off")
      }
      // Before the demo cookie or Supabase are looked at.
      expect(createMiddlewareClient).not.toHaveBeenCalled()
    },
  )

  it("does not block look-alikes, or the pages around it", async () => {
    vi.stubEnv("NODE_ENV", "production")
    for (const path of ["/devices", "/developers", "/", "/sign-in"]) {
      expect(outcome(await visit(path))).toBe("next")
    }
    expect(outcome(await visit("/company", "admin"))).toBe("next")
  })

  it.each(["/dev", "/dev/", "/dev/api", "/%64ev"])(
    "lets %s through in development, and in production with the flag",
    async (path) => {
      vi.stubEnv("NODE_ENV", "development")
      expect(outcome(await visit(path))).toBe("next")
      vi.stubEnv("NODE_ENV", "production")
      vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS", "1")
      expect(outcome(await visit(path))).toBe("next")
    },
  )

  it("answers 404 on mainnet even with the flag", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS", "1")
    config.isMainnet = true
    expect(status(await visit("/dev/api"))).toBe(404)
  })

  it("fails closed when the cluster setting is bad, and still serves the public pages", async () => {
    config.broken = true
    expect(status(await visit("/dev/api"))).toBe(404)
    expect(outcome(await visit("/sign-in"))).toBe("next")
  })
})

describe("demo cookie in the demo configuration", () => {
  it.each([
    ["admin", "/company"],
    ["admin", "/company/people"],
    ["recipient", "/me"],
    ["auditor", "/audit"],
  ])("lets a demo %s into %s", async (role, path) => {
    expect(outcome(await visit(path, role))).toBe("next")
  })

  it.each([
    ["admin", "/me", "/company"],
    ["recipient", "/company", "/me"],
    ["auditor", "/company/deposit", "/audit"],
    ["recipient", "/audit", "/me"],
  ])("sends a demo %s from %s to %s", async (role, path, home) => {
    expect(outcome(await visit(path, role))).toBe(home)
  })

  it("sends a visit without the cookie to sign-in, remembering the page", async () => {
    expect(outcome(await visit("/company/people"))).toBe(
      "/sign-in?next=%2Fcompany%2Fpeople",
    )
  })

  it.each(["root", "Admin", ""])(
    "treats the cookie value %j as signed out",
    async (value) => {
      expect(outcome(await visit("/me", value))).toBe("/sign-in?next=%2Fme")
    },
  )

  it("lets public pages through with or without it", async () => {
    expect(outcome(await visit("/sign-in"))).toBe("next")
    expect(outcome(await visit("/", "admin"))).toBe("next")
  })

  it("never calls Supabase", async () => {
    await visit("/company", "admin")
    await visit("/company")
    await visit("/sign-in")
    expect(createMiddlewareClient).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
  })
})

describe("demo cookie everywhere else is ignored", () => {
  it("ignores it when Supabase is configured, and asks Supabase", async () => {
    config.supabaseConfigured = true
    expect(outcome(await visit("/company", "admin"))).toBe(
      "/sign-in?next=%2Fcompany",
    )
    expect(createMiddlewareClient).toHaveBeenCalledOnce()
    expect(getUser).toHaveBeenCalledOnce()
  })

  it("ignores it in real mode", async () => {
    config.mode = "real"
    createMiddlewareClient.mockImplementation(() => {
      throw new Error("Set NEXT_PUBLIC_SUPABASE_URL")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(outcome(await visit("/company", "admin"))).toBe(
      "/sign-in?next=%2Fcompany",
    )
    expect(outcome(await visit("/me", "recipient"))).toBe("/sign-in?next=%2Fme")
  })

  it("ignores it in real mode with Supabase configured", async () => {
    config.mode = "real"
    config.supabaseConfigured = true
    expect(outcome(await visit("/audit", "auditor"))).toBe(
      "/sign-in?next=%2Faudit",
    )
    expect(getUser).toHaveBeenCalledOnce()
  })

  it("ignores it on mainnet", async () => {
    config.isMainnet = true
    createMiddlewareClient.mockImplementation(() => {
      throw new Error("Set NEXT_PUBLIC_SUPABASE_URL")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(outcome(await visit("/company", "admin"))).toBe(
      "/sign-in?next=%2Fcompany",
    )
  })

  it("still lets public pages through without Supabase", async () => {
    config.mode = "real"
    createMiddlewareClient.mockImplementation(() => {
      throw new Error("Set NEXT_PUBLIC_SUPABASE_URL")
    })
    expect(outcome(await visit("/sign-in", "admin"))).toBe("next")
  })
})

describe("a Supabase session", () => {
  const signedIn = (role: "admin" | "recipient" | "auditor" | null) => {
    config.supabaseConfigured = true
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } } })
    vi.mocked(membershipOf).mockResolvedValue(
      role && { role, company: { id: "company-1", name: "Solaris" } },
    )
  }

  it("lets a member into their own area", async () => {
    signedIn("admin")
    expect(outcome(await visit("/company/people"))).toBe("next")
    expect(membershipOf).toHaveBeenCalledWith(expect.anything(), "user-1")
    expect(signOut).not.toHaveBeenCalled()
  })

  it.each([
    ["recipient", "/company", "/me"],
    ["admin", "/audit", "/company"],
    ["auditor", "/me/history", "/audit"],
  ] as const)("sends a %s from %s to %s", async (role, path, home) => {
    signedIn(role)
    expect(outcome(await visit(path))).toBe(home)
  })

  it("sends a visitor with no session to sign-in, query string kept", async () => {
    config.supabaseConfigured = true
    expect(outcome(await visit("/company/people?tab=invites&q=a%20b"))).toBe(
      "/sign-in?next=%2Fcompany%2Fpeople%3Ftab%3Dinvites%26q%3Da%2520b",
    )
    expect(membershipOf).not.toHaveBeenCalled()
  })

  it("lets a visitor with no session see public pages", async () => {
    config.supabaseConfigured = true
    expect(outcome(await visit("/sign-in?invite=tok"))).toBe("next")
  })

  it("ends a session without a membership on this device only, then explains", async () => {
    signedIn(null)
    expect(outcome(await visit("/company"))).toBe("/sign-in?error=no_company")
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
  })

  it("ends it on public pages too: no session lingers without a company", async () => {
    signedIn(null)
    expect(outcome(await visit("/"))).toBe("/sign-in?error=no_company")
    expect(signOut).toHaveBeenCalledOnce()
  })

  it("does not redirect to the no-company page again once it is there", async () => {
    signedIn(null)
    expect(outcome(await visit("/sign-in?error=no_company"))).toBe("next")
    expect(signOut).not.toHaveBeenCalled()
  })

  it("still redirects, once, when the logout fails", async () => {
    signedIn(null)
    signOut.mockResolvedValue({ error: { message: "gotrue is down" } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(outcome(await visit("/company"))).toBe("/sign-in?error=no_company")
    expect(console.error).toHaveBeenCalledWith(
      "signOut failed",
      "gotrue is down",
    )
    // The page it leads to does not try again, so a failing logout cannot loop.
    expect(outcome(await visit("/sign-in?error=no_company"))).toBe("next")
    expect(signOut).toHaveBeenCalledOnce()
  })

  it("only skips for sign-in with that exact error", async () => {
    signedIn(null)
    expect(outcome(await visit("/sign-in?error=link_expired"))).toBe(
      "/sign-in?error=no_company",
    )
    expect(outcome(await visit("/sign-up?error=no_company"))).toBe(
      "/sign-in?error=no_company",
    )
  })

  it("leaves Next's own _rsc and __next params out of `next`", async () => {
    config.supabaseConfigured = true
    expect(
      outcome(
        await visit("/company/people?tab=invites&_rsc=abc12&__nextDataReq=1"),
      ),
    ).toBe("/sign-in?next=%2Fcompany%2Fpeople%3Ftab%3Dinvites")
    expect(outcome(await visit("/company?_rsc=abc12"))).toBe(
      "/sign-in?next=%2Fcompany",
    )
  })

  it("carries the session cookies and no-store headers onto redirects", async () => {
    signedIn("recipient")
    createMiddlewareClient.mockImplementation(() => ({
      supabase: { auth: { getUser, signOut } },
      response: () => {
        const response = NextResponse.next()
        response.cookies.set("sb-session", "refreshed")
        return response
      },
      cacheHeaders: { "cache-control": "no-store" },
    }))
    const response = await visit("/company")
    expect(outcome(response)).toBe("/me")
    expect(response.cookies.get("sb-session")?.value).toBe("refreshed")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  describe("when the membership lookup fails", () => {
    beforeEach(() => {
      signedIn("admin")
      vi.mocked(membershipOf).mockRejectedValue(new Error("lookup failed"))
      vi.spyOn(console, "error").mockImplementation(() => {})
    })

    it("does not sign anyone out over it", async () => {
      await visit("/company")
      await visit("/sign-in")
      expect(signOut).not.toHaveBeenCalled()
    })

    it("treats a guarded page as signed out", async () => {
      expect(outcome(await visit("/company?tab=x"))).toBe(
        "/sign-in?next=%2Fcompany%3Ftab%3Dx",
      )
    })

    it("still serves public pages", async () => {
      expect(outcome(await visit("/sign-in"))).toBe("next")
      expect(outcome(await visit("/"))).toBe("next")
    })
  })
})

describe("a configuration that throws", () => {
  beforeEach(() => {
    config.broken = true
    createMiddlewareClient.mockImplementation(() => {
      throw new Error("Set NEXT_PUBLIC_SUPABASE_URL")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("still serves public pages", async () => {
    expect(outcome(await visit("/"))).toBe("next")
    expect(outcome(await visit("/sign-in", "admin"))).toBe("next")
  })

  it("turns the demo off for guarded pages, as before the demo existed", async () => {
    expect(outcome(await visit("/company", "admin"))).toBe(
      "/sign-in?next=%2Fcompany",
    )
  })
})

describe("without Supabase configured (real mode, no demo)", () => {
  beforeEach(() => {
    config.mode = "real"
    config.supabaseConfigured = false
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("keeps the guarded areas closed, quietly, and never builds a client for it", async () => {
    for (const path of ["/company", "/company/runs/new", "/me", "/audit"]) {
      expect(outcome(await visit(path))).toBe(
        `/sign-in?next=${encodeURIComponent(path)}`,
      )
    }
    expect(createMiddlewareClient).not.toHaveBeenCalled()
    // It is every request: nothing is logged for the configuration, so no log is flooded.
    expect(console.error).not.toHaveBeenCalled()
  })

  it("serves the public pages and never throws on any request", async () => {
    for (const path of ["/", "/sign-in", "/sign-up", "/auth/confirm"]) {
      expect(outcome(await visit(path))).toBe("next")
    }
    expect(console.error).not.toHaveBeenCalled()
  })

  it("logs only the kind of error when a configured client cannot be made, and still fails closed", async () => {
    config.supabaseConfigured = true
    createMiddlewareClient.mockImplementation(() => {
      throw new TypeError("https://secret-project.supabase.co is unreachable")
    })
    expect(outcome(await visit("/company"))).toBe("/sign-in?next=%2Fcompany")
    expect(console.error).toHaveBeenCalledExactlyOnceWith("TypeError")
    expect(outcome(await visit("/sign-in"))).toBe("next")
  })
})
