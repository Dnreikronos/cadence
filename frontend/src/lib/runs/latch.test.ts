import { describe, expect, it } from "vitest"
import { createLatch } from "./latch"

describe("createLatch", () => {
  it("lets the first caller in and turns the second away", () => {
    const latch = createLatch()
    expect(latch.tryEnter()).toBe(true)
    expect(latch.tryEnter()).toBe(false)
    expect(latch.held).toBe(true)
  })

  it("lets one in again once it is released", () => {
    const latch = createLatch()
    latch.tryEnter()
    latch.release()
    expect(latch.held).toBe(false)
    expect(latch.tryEnter()).toBe(true)
  })

  it("sends one request for a double click, whatever the request does", async () => {
    const latch = createLatch()
    let sent = 0
    async function click() {
      if (!latch.tryEnter()) return
      sent += 1
      try {
        await Promise.resolve()
      } finally {
        latch.release()
      }
    }
    // Two clicks in the same tick, before the first has awaited anything.
    await Promise.all([click(), click()])
    expect(sent).toBe(1)
    await click()
    expect(sent).toBe(2)
  })

  it("is independent per latch", () => {
    const a = createLatch()
    const b = createLatch()
    a.tryEnter()
    expect(b.tryEnter()).toBe(true)
  })
})
