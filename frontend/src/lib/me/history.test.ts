import { describe, expect, it } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import { historyView, loadedMoreMessage } from "./history"

const payment = (n: number): PaymentItem => ({
  payment_id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  run_id: null,
  counterparty: { id: "a0000000-0000-4000-8000-000000000001", name: "Solaris" },
  amount: "1000000",
  status: "confirmed",
  transparent: false,
  paid_at: "2026-09-01T12:00:00Z",
  signature: null,
})

describe("historyView", () => {
  it("is loading before anything arrives, and an error if the first read failed", () => {
    expect(historyView({ isError: false })).toEqual({ kind: "loading" })
    expect(historyView({ isError: true })).toEqual({ kind: "error" })
  })

  it("is empty for a history with no payments", () => {
    expect(
      historyView({ data: { pages: [{ items: [] }] }, isError: false }),
    ).toEqual({ kind: "empty" })
  })

  it("keeps the rows when a refresh or the next page fails", () => {
    const view = historyView({
      data: { pages: [{ items: [payment(1), payment(2)] }] },
      isError: true,
    })
    expect(view.kind).toBe("list")
    expect(view.kind === "list" && view.items).toHaveLength(2)
  })

  it("lists every page once, even if a payment arrived between pages", () => {
    const view = historyView({
      data: {
        pages: [
          { items: [payment(1), payment(2)] },
          { items: [payment(2), payment(3)] },
        ],
      },
      isError: false,
    })
    expect(
      view.kind === "list" && view.items.map((p) => p.payment_id.slice(-2)),
    ).toEqual(["01", "02", "03"])
  })
})

describe("loadedMoreMessage", () => {
  it("counts what was added", () => {
    expect(loadedMoreMessage(20, 27)).toBe("Loaded 7 more payments")
    expect(loadedMoreMessage(20, 21)).toBe("Loaded 1 more payment")
  })

  it("says so when there was nothing more", () => {
    expect(loadedMoreMessage(20, 20)).toBe("No more payments to load")
  })
})
