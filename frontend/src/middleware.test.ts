import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  mode: "mock",
  supabaseConfigured: false,
  isMainnet: false,
}))
const createMiddlewareClient = vi.hoisted(() => vi.fn())
const getUser = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))
vi.mock("@/lib/solana/cluster", () => ({
  cluster: {
    get isMainnet() {
      return config.isMainnet
    },
  },
}))
vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => config.supabaseConfigured,
}))
vi.mock("@/lib/supabase/middleware", () => ({ createMiddlewareClient }))
vi.mock("@/lib/supabase/membership", () => ({ membershipOf: vi.fn() }))

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

beforeEach(() => {
  Object.assign(config, {
    mode: "mock",
    supabaseConfigured: false,
    isMainnet: false,
  })
  createMiddlewareClient.mockReset()
  getUser.mockReset()
  // Supabase configured: a visitor with no session.
  getUser.mockResolvedValue({ data: { user: null } })
  createMiddlewareClient.mockImplementation(() => ({
    supabase: { auth: { getUser } },
    response: () => NextResponse.next(),
    cacheHeaders: {},
  }))
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
