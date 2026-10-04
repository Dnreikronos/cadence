import { afterEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({ mode: "mock" }))
vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))

import { ME_WALLET, db, resetDb } from "@/lib/api/mocks/db"
import { isMockMode, resetMockActivation, wantsFreshDemo } from "./fresh"

afterEach(() => {
  config.mode = "mock"
  resetDb()
})

const search = (query: string) => new URLSearchParams(query)

describe("wantsFreshDemo", () => {
  it("asks for a fresh recipient only for fresh=1 in mock mode", () => {
    expect(wantsFreshDemo(search("fresh=1"), true)).toBe(true)
    expect(wantsFreshDemo(search(""), true)).toBe(false)
    expect(wantsFreshDemo(search("fresh=0"), true)).toBe(false)
    expect(wantsFreshDemo(search("fresh=true"), true)).toBe(false)
  })

  it("ignores the parameter outside mock mode", () => {
    expect(wantsFreshDemo(search("fresh=1"), false)).toBe(false)
    config.mode = "real"
    expect(isMockMode()).toBe(false)
  })
})

describe("resetMockActivation", () => {
  it("undoes the demo recipient's setup, which the seed has done", async () => {
    expect(db.accountConfigured).toBe(true)
    await resetMockActivation()
    expect(db.enrolled.has(ME_WALLET)).toBe(false)
    expect(db.walletLinked).toBe(false)
    expect(db.accountConfigured).toBe(false)
  })

  it("does nothing outside mock mode", async () => {
    config.mode = "real"
    await resetMockActivation()
    expect(db.accountConfigured).toBe(true)
  })
})
