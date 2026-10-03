import { afterEach, describe, expect, it, vi } from "vitest"
import { idSchema } from "./schemas"
import { randomUuid } from "./uuid"

const v4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => vi.unstubAllGlobals())

describe("randomUuid", () => {
  it("uses crypto.randomUUID when there is one", () => {
    expect(randomUuid()).toMatch(v4)
  })

  it("falls back to getRandomValues where randomUUID is missing (plain http)", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    })
    const ids = Array.from({ length: 50 }, randomUuid)
    for (const id of ids) {
      expect(id).toMatch(v4)
      expect(idSchema.safeParse(id).success).toBe(true)
    }
    expect(new Set(ids).size).toBe(50)
  })
})
