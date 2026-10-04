import { afterEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({ mode: "mock" }))
vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))

import { keyDerivationMessage } from "./message"

afterEach(() => {
  config.mode = "mock"
})

describe("keyDerivationMessage", () => {
  it("is the same bytes for the same wallet and names the wallet, in mock mode", () => {
    const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
    const message = keyDerivationMessage(wallet)
    expect(message).toEqual(keyDerivationMessage(wallet))
    expect(new TextDecoder().decode(message)).toContain(wallet)
    expect(message).not.toEqual(keyDerivationMessage("another-wallet"))
  })

  it("refuses to build the placeholder in real mode", () => {
    config.mode = "real"
    expect(() => keyDerivationMessage("any")).toThrow(/placeholder/)
  })
})
