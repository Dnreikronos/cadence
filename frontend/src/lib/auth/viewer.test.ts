import { beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  mode: "mock",
  supabaseConfigured: false,
  isMainnet: false,
}))
const cookieValue = vi.hoisted(() => ({
  current: undefined as string | undefined,
}))
const getUser = vi.hoisted(() => vi.fn())
const createClient = vi.hoisted(() => vi.fn())
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect:${to}`)
  }),
)

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
vi.mock("@/lib/supabase/server", () => ({ createClient }))
vi.mock("@/lib/supabase/membership", () => ({ membershipOf: vi.fn() }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cadence-demo-role" && cookieValue.current !== undefined
        ? { name, value: cookieValue.current }
        : undefined,
  }),
}))
vi.mock("next/navigation", () => ({ redirect }))

import { currentViewer, requireMember } from "./viewer"

beforeEach(() => {
  Object.assign(config, {
    mode: "mock",
    supabaseConfigured: false,
    isMainnet: false,
  })
  cookieValue.current = undefined
  getUser.mockReset().mockResolvedValue({ data: { user: null } })
  createClient.mockReset().mockResolvedValue({ auth: { getUser } })
  redirect.mockClear()
})

describe("currentViewer in the demo configuration", () => {
  it.each([
    ["admin", "ana@solaris.test"],
    ["recipient", "bruno@solaris.test"],
    ["auditor", "carla@acme-audit.test"],
  ])("is the demo %s", async (role, email) => {
    cookieValue.current = role
    expect(await currentViewer()).toEqual({
      email,
      membership: { role, company: { name: "Solaris" } },
    })
  })

  it("is nobody without the cookie, or with a forged value", async () => {
    expect(await currentViewer()).toBeNull()
    cookieValue.current = "superuser"
    expect(await currentViewer()).toBeNull()
  })

  it("never asks Supabase", async () => {
    cookieValue.current = "admin"
    await currentViewer()
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe("the demo cookie is ignored elsewhere", () => {
  beforeEach(() => {
    cookieValue.current = "admin"
  })

  it("when Supabase is configured: only its session counts", async () => {
    config.supabaseConfigured = true
    expect(await currentViewer()).toBeNull()
    expect(getUser).toHaveBeenCalledOnce()
  })

  it("in real mode", async () => {
    config.mode = "real"
    expect(await currentViewer()).toBeNull()
  })

  it("in real mode with Supabase configured", async () => {
    config.mode = "real"
    config.supabaseConfigured = true
    expect(await currentViewer()).toBeNull()
    expect(getUser).toHaveBeenCalledOnce()
  })

  it("on mainnet", async () => {
    config.isMainnet = true
    expect(await currentViewer()).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe("requireMember for a demo viewer", () => {
  it("returns the viewer for their own area", async () => {
    cookieValue.current = "recipient"
    expect((await requireMember("recipient")).email).toBe("bruno@solaris.test")
  })

  it("sends a viewer from another role's area home", async () => {
    cookieValue.current = "recipient"
    await expect(requireMember("admin")).rejects.toThrow("redirect:/me")
    cookieValue.current = "auditor"
    await expect(requireMember("recipient")).rejects.toThrow("redirect:/audit")
  })

  it("sends a visit without the cookie to sign-in", async () => {
    await expect(requireMember("admin")).rejects.toThrow("redirect:/sign-in")
  })
})
