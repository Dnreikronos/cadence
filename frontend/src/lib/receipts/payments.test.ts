import { describe, expect, it } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import {
  filterPayments,
  flattenPayments,
  isFiltering,
  noFilters,
} from "./payments"

const payment = (
  name: string,
  status: PaymentItem["status"],
  n: number,
): PaymentItem => ({
  payment_id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  run_id: null,
  counterparty: {
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
  },
  amount: "1000000",
  status,
  transparent: false,
  paid_at: "2026-09-01T12:00:00Z",
  signature: null,
})

const all = [
  payment("Bruno Costa", "confirmed", 1),
  payment("Mariana Souza", "failed", 2),
  payment("Northwind Audit", "pending", 3),
  payment("bruno ÁVILA", "failed", 4),
]
const ids = (list: PaymentItem[]) => list.map((p) => p.counterparty.name)

describe("filterPayments", () => {
  it("returns every payment, in order, when nothing is filtered", () => {
    expect(filterPayments(all, noFilters)).toEqual(all)
  })

  it("filters by status", () => {
    expect(ids(filterPayments(all, { status: "failed", search: "" }))).toEqual([
      "Mariana Souza",
      "bruno ÁVILA",
    ])
  })

  it("searches the name without regard to case or surrounding space", () => {
    expect(
      ids(filterPayments(all, { status: "all", search: "  BRUNO " })),
    ).toEqual(["Bruno Costa", "bruno ÁVILA"])
    expect(
      ids(filterPayments(all, { status: "all", search: "ávila" })),
    ).toEqual(["bruno ÁVILA"])
  })

  it("applies both filters together", () => {
    expect(
      ids(filterPayments(all, { status: "failed", search: "bruno" })),
    ).toEqual(["bruno ÁVILA"])
    expect(filterPayments(all, { status: "pending", search: "bruno" })).toEqual(
      [],
    )
  })

  it("treats what the person types as text, not a pattern", () => {
    expect(filterPayments(all, { status: "all", search: ".*" })).toEqual([])
  })
})

describe("isFiltering", () => {
  it("is false only when both filters are at rest", () => {
    expect(isFiltering(noFilters)).toBe(false)
    expect(isFiltering({ status: "all", search: "   " })).toBe(false)
    expect(isFiltering({ status: "failed", search: "" })).toBe(true)
    expect(isFiltering({ status: "all", search: "a" })).toBe(true)
  })
})

describe("flattenPayments", () => {
  it("joins the pages in order", () => {
    expect(
      flattenPayments([{ items: [all[0], all[1]] }, { items: [all[2]] }]),
    ).toEqual([all[0], all[1], all[2]])
    expect(flattenPayments([])).toEqual([])
  })

  it("keeps a payment that two pages both returned once, in its first place", () => {
    const again = { ...all[1], status: "confirmed" as const }
    const list = flattenPayments([
      { items: [all[0], all[1]] },
      { items: [again, all[2]] },
    ])
    expect(list.map((p) => p.payment_id)).toEqual([
      all[0].payment_id,
      all[1].payment_id,
      all[2].payment_id,
    ])
    expect(list[1]).toBe(all[1])
  })
})
