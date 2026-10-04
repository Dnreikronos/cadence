import { describe, expect, it, vi } from "vitest"
import { printWithTitle, type PrintEnv } from "./print"

function fakeEnv() {
  const listeners = new Map<string, Set<() => void>>()
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  const titles: string[] = []
  const env = {
    document: { title: "Receipts" },
    window: {
      print: vi.fn(() => titles.push(env.document.title)),
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener)
      },
    },
    setTimeout: (callback: () => void, ms: number) => {
      timers.push({ callback, ms, cleared: false })
      return timers.length - 1
    },
    clearTimeout: (handle: number) => {
      timers[handle].cleared = true
    },
  } as unknown as PrintEnv & { document: { title: string } }
  const fire = (type: string) =>
    [...(listeners.get(type) ?? [])].forEach((l) => l())
  return { env, fire, timers, titles, listeners }
}

describe("printWithTitle", () => {
  it("prints under the receipt's title, which names the saved PDF", () => {
    const { env, titles } = fakeEnv()
    printWithTitle("Cadence receipt 2026-09-01 Bruno", env)
    expect(titles).toEqual(["Cadence receipt 2026-09-01 Bruno"])
  })

  it.each(["afterprint", "focus"])(
    "puts the page title back on %s, and stops listening",
    (event) => {
      const { env, fire, listeners, timers } = fakeEnv()
      printWithTitle("Cadence receipt 2026-09-01 Bruno", env)
      expect(env.document.title).toBe("Cadence receipt 2026-09-01 Bruno")

      fire(event)

      expect(env.document.title).toBe("Receipts")
      expect(listeners.get("afterprint")?.size).toBe(0)
      expect(listeners.get("focus")?.size).toBe(0)
      expect(timers[0].cleared).toBe(true)
    },
  )

  it("puts it back after a minute when the browser fires neither event", () => {
    const { env, timers } = fakeEnv()
    printWithTitle("Cadence receipt 2026-09-01 Bruno", env)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(60_000)

    timers[0].callback()

    expect(env.document.title).toBe("Receipts")
  })

  it("restores the title it found, not a receipt's, when printed twice", () => {
    const { env, fire } = fakeEnv()
    printWithTitle("first", env)
    fire("afterprint")
    printWithTitle("second", env)
    fire("focus")
    expect(env.document.title).toBe("Receipts")
  })
})
