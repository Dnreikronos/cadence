import { describe, expect, it, vi } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import {
  readRecentlyPaid,
  recentPages,
  tooManyRecent,
  tooManyRecentMessage,
} from "./recent"

const NOW = Date.parse("2026-10-04T12:00:00Z")
const hours = (n: number) => new Date(NOW - n * 3_600_000).toISOString()
const guid = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function payment(n: number, hoursAgo: number): PaymentItem {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    status: "confirmed",
    paid_at: hoursAgo === 0 ? hours(0) : hours(hoursAgo),
    counterparty: { id: guid(n), name: `P${n}` },
  } as unknown as PaymentItem
}

describe("readRecentlyPaid", () => {
  it("returns who was paid in the last 24 hours and stops at the first page that ends before the window", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined
        ? { items: [payment(1, 1), payment(2, 30)], next_cursor: "more" }
        : { items: [payment(3, 2)], next_cursor: null },
    )
    const paid = await readRecentlyPaid(fetchPage, NOW)
    expect([...paid]).toEqual([guid(1)])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("reads on while the window is still open", async () => {
    const pages: Record<
      string,
      { items: PaymentItem[]; next_cursor: string | null }
    > = {
      start: { items: [payment(1, 1)], next_cursor: "a" },
      a: { items: [payment(2, 2)], next_cursor: "b" },
      b: { items: [payment(3, 40)], next_cursor: "c" },
    }
    const fetchPage = vi.fn(
      async (cursor: string | undefined) => pages[cursor ?? "start"],
    )
    const paid = await readRecentlyPaid(fetchPage, NOW)
    expect([...paid].sort()).toEqual([guid(1), guid(2)])
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it("does not answer from part of the window: past five pages it throws, so no run starts on a partial answer", async () => {
    const fetchPage = vi.fn(async () => ({
      items: [payment(1, 1)],
      next_cursor: "more",
    }))
    const failure = await readRecentlyPaid(fetchPage, NOW).catch((e) => e)
    expect(fetchPage).toHaveBeenCalledTimes(recentPages)
    expect(recentPages).toBe(5)
    expect(failure).toBeInstanceOf(RangeError)
    expect(tooManyRecent(failure)).toBe(true)
  })

  it("says what is wrong, and that no run can start, instead of a generic failure", () => {
    expect(tooManyRecentMessage).toMatch(/More than 500 payments/)
    expect(tooManyRecentMessage).toMatch(/a run can't be started/)
    expect(tooManyRecent(new Error("down"))).toBe(false)
  })

  it("passes a failed read on, so a run does not start either", async () => {
    await expect(
      readRecentlyPaid(async () => {
        throw new Error("down")
      }, NOW),
    ).rejects.toThrow("down")
  })
})
