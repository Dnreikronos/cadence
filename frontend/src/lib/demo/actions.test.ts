import { beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  mode: "mock",
  supabaseConfigured: false,
  isMainnet: false,
}))
const store = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }))
const supabaseSignOut = vi.hoisted(() => vi.fn())
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signOut: supabaseSignOut } }),
}))
vi.mock("next/headers", () => ({
  cookies: async () => store,
  headers: async () => new Headers(),
}))
vi.mock("next/navigation", () => ({ redirect }))

import { signOut } from "@/lib/auth/actions"
import { signInAsDemo } from "./actions"

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

beforeEach(() => {
  Object.assign(config, {
    mode: "mock",
    supabaseConfigured: false,
    isMainnet: false,
  })
  store.set.mockClear()
  store.delete.mockClear()
  supabaseSignOut.mockClear()
  redirect.mockClear()
})

describe("signInAsDemo", () => {
  it.each([
    ["admin", "/company"],
    ["recipient", "/me"],
    ["auditor", "/audit"],
  ])(
    "sets an httpOnly lax cookie for %s and goes to %s",
    async (role, home) => {
      await expect(signInAsDemo(form({ role }))).rejects.toThrow(
        `redirect:${home}`,
      )
      expect(store.set).toHaveBeenCalledWith(
        "cadence-demo-role",
        role,
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        }),
      )
    },
  )

  it("goes where the visitor was headed, if their role may", async () => {
    await expect(
      signInAsDemo(form({ role: "admin", next: "/company/people" })),
    ).rejects.toThrow("redirect:/company/people")
    await expect(
      signInAsDemo(form({ role: "recipient", next: "/company/people" })),
    ).rejects.toThrow("redirect:/me")
    await expect(
      signInAsDemo(form({ role: "admin", next: "https://evil.test/company" })),
    ).rejects.toThrow("redirect:/company")
  })

  it("sets nothing for an unknown role", async () => {
    await expect(signInAsDemo(form({ role: "root" }))).rejects.toThrow(
      "redirect:/sign-in",
    )
    await expect(signInAsDemo(form({}))).rejects.toThrow("redirect:/sign-in")
    expect(store.set).not.toHaveBeenCalled()
  })

  it.each([
    ["Supabase is configured", { supabaseConfigured: true }],
    ["the API is real", { mode: "real" }],
    ["the cluster is mainnet", { isMainnet: true }],
  ])("sets nothing when %s", async (_, change) => {
    Object.assign(config, change)
    await expect(signInAsDemo(form({ role: "admin" }))).rejects.toThrow(
      "redirect:/sign-in",
    )
    expect(store.set).not.toHaveBeenCalled()
  })
})

describe("signOut", () => {
  it("clears the demo cookie and returns to sign-in", async () => {
    await expect(signOut()).rejects.toThrow("redirect:/sign-in")
    expect(store.delete).toHaveBeenCalledWith("cadence-demo-role")
    expect(supabaseSignOut).not.toHaveBeenCalled()
  })

  it("ends the Supabase session when it is configured, and clears the cookie too", async () => {
    config.supabaseConfigured = true
    await expect(signOut()).rejects.toThrow("redirect:/")
    expect(supabaseSignOut).toHaveBeenCalledOnce()
    expect(store.delete).toHaveBeenCalledWith("cadence-demo-role")
  })
})
