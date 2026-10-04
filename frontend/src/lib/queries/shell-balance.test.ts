import { describe, expect, it, vi } from "vitest"
import { shellBalanceOf } from "./shell-balance"

const refetch = vi.fn()
const base = { isError: false, isFetching: false, refetch }

describe("shellBalanceOf", () => {
  it("shows the shimmer while the first load runs", () => {
    expect(shellBalanceOf({ ...base, isFetching: true })).toEqual({
      state: "loading",
    })
  })

  it("reveals the available balance in dollars", () => {
    expect(
      shellBalanceOf({ ...base, data: { available: "84000000000" } }),
    ).toEqual({ amount: 84000, state: "revealed" })
    expect(shellBalanceOf({ ...base, data: { available: "0" } })).toEqual({
      amount: 0,
      state: "revealed",
    })
  })

  it("keeps a revealed balance when a refresh fails", () => {
    const shown = shellBalanceOf({
      ...base,
      data: { available: "1500000" },
      isError: true,
    })
    expect(shown).toEqual({ amount: 1.5, state: "revealed" })
  })

  it("reports a failed load with a way to try again", () => {
    const shown = shellBalanceOf({ ...base, isError: true })
    expect(shown).toMatchObject({ state: "hidden", error: true })
    shown.onRetry?.()
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("goes back to the shimmer while a failed load is retried", () => {
    expect(
      shellBalanceOf({ ...base, isError: true, isFetching: true }),
    ).toEqual({ state: "loading" })
  })
})
