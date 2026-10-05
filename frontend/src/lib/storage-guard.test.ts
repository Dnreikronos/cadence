import { describe, expect, it } from "vitest"
import {
  StorageUnavailableError,
  requireDurable,
  storageBlockedMessage,
  storageGate,
} from "./storage-guard"

describe("storageGate", () => {
  it("lets a screen start when storage works, in either mode", () => {
    for (const mode of ["mock", "real"] as const) {
      expect(storageGate(mode, () => true)).toEqual({
        ok: true,
        blocks: false,
        warns: false,
      })
    }
  })

  it("refuses the start in real mode when storage does not work", () => {
    expect(storageGate("real", () => false)).toEqual({
      ok: false,
      blocks: true,
      warns: false,
    })
  })

  it("only warns in mock mode, where nothing real moves", () => {
    expect(storageGate("mock", () => false)).toEqual({
      ok: false,
      blocks: false,
      warns: true,
    })
  })
})

describe("requireDurable", () => {
  it("stops a real-mode send whose record was not kept, with the message for the person", () => {
    expect(() => requireDurable("real", false)).toThrow(StorageUnavailableError)
    expect(() => requireDurable("real", () => false)).toThrow(
      storageBlockedMessage,
    )
  })

  it("goes on when the record was kept, and in mock mode whatever happened", () => {
    expect(() => requireDurable("real", true)).not.toThrow()
    expect(() => requireDurable("real", () => true)).not.toThrow()
    expect(() => requireDurable("mock", false)).not.toThrow()
  })

  it("says what to do, in plain words", () => {
    expect(storageBlockedMessage).toBe(
      "Your browser is blocking storage, so Cadence cannot safely send this: enable site storage or leave private browsing",
    )
  })
})
