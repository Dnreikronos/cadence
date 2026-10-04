import { describe, expect, it, vi } from "vitest"
import { refetchFailed } from "./refetch-failed"

describe("refetchFailed", () => {
  it("retries every failed query, and only those", () => {
    const people = { isError: true, refetch: vi.fn() }
    const recent = { isError: true, refetch: vi.fn() }
    const balance = { isError: false, refetch: vi.fn() }
    expect(refetchFailed([people, recent, balance])).toBe(2)
    expect(people.refetch).toHaveBeenCalledOnce()
    expect(recent.refetch).toHaveBeenCalledOnce()
    expect(balance.refetch).not.toHaveBeenCalled()
  })

  it("does nothing when nothing failed", () => {
    const ok = { isError: false, refetch: vi.fn() }
    expect(refetchFailed([ok])).toBe(0)
    expect(ok.refetch).not.toHaveBeenCalled()
  })
})
