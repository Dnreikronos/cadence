import { describe, expect, it } from "vitest"
import type { PaymentItem } from "@/lib/api/schemas"
import {
  auditRow,
  filterPayments,
  filtersActive,
  isStatusFilter,
  noFilters,
  receiptLabel,
} from "./payments"

const item = (
  n: number,
  name: string,
  status: PaymentItem["status"],
  extra: Partial<PaymentItem> = {},
): PaymentItem => ({
  payment_id: `b0000000-0000-4000-8000-00000000000${n}`,
  run_id: null,
  counterparty: { id: `a0000000-0000-4000-8000-00000000000${n}`, name },
  amount: "4200000000",
  status,
  transparent: false,
  paid_at: "2026-09-01T12:00:00Z",
  signature: "sig",
  ...extra,
})

const items = [
  item(1, "Bruno Costa", "confirmed"),
  item(2, "Carla Dias", "pending"),
  item(3, "Diego Faria", "failed"),
  item(4, "Bruna Lima", "confirmed"),
]

describe("filterPayments", () => {
  it("keeps everything without filters, in order", () => {
    expect(filterPayments(items, noFilters)).toEqual(items)
  })

  it("filters by status", () => {
    const names = filterPayments(items, { status: "confirmed", search: "" })
    expect(names.map((i) => i.counterparty.name)).toEqual([
      "Bruno Costa",
      "Bruna Lima",
    ])
  })

  it("searches the name without case or surrounding spaces", () => {
    const found = filterPayments(items, { status: "all", search: "  BRUN " })
    expect(found.map((i) => i.counterparty.name)).toEqual([
      "Bruno Costa",
      "Bruna Lima",
    ])
  })

  it("needs both filters to match", () => {
    expect(
      filterPayments(items, { status: "pending", search: "bruno" }),
    ).toEqual([])
    expect(
      filterPayments(items, { status: "pending", search: "carla" }),
    ).toEqual([items[1]])
  })

  it("treats a search as text, not a pattern", () => {
    expect(filterPayments(items, { status: "all", search: ".*" })).toEqual([])
  })
})

describe("filtersActive", () => {
  it("is false for the defaults and for a blank search", () => {
    expect(filtersActive(noFilters)).toBe(false)
    expect(filtersActive({ status: "all", search: "   " })).toBe(false)
  })

  it("is true for a status or a search", () => {
    expect(filtersActive({ status: "failed", search: "" })).toBe(true)
    expect(filtersActive({ status: "all", search: "a" })).toBe(true)
  })
})

describe("isStatusFilter", () => {
  it("accepts the statuses a payment carries and all", () => {
    for (const value of ["all", "pending", "confirmed", "failed"]) {
      expect(isStatusFilter(value)).toBe(true)
    }
  })

  it("rejects anything else", () => {
    for (const value of ["", "signed", "expired", "ALL"]) {
      expect(isStatusFilter(value)).toBe(false)
    }
  })
})

describe("auditRow", () => {
  it("converts the amount exactly for display and carries the rest", () => {
    expect(
      auditRow(
        item(1, "Bruno Costa", "confirmed", {
          amount: "1234500000",
          transparent: true,
        }),
      ),
    ).toEqual({
      id: "b0000000-0000-4000-8000-000000000001",
      name: "Bruno Costa",
      usd: 1234.5,
      status: "confirmed",
      transparent: true,
      paidAt: "2026-09-01T12:00:00Z",
      signature: "sig",
    })
  })

  it("keeps a payment without a signature", () => {
    expect(
      auditRow(item(1, "A", "pending", { signature: null })).signature,
    ).toBeNull()
  })
})

describe("receiptLabel", () => {
  it("names the person and the time, so same-day payments differ", () => {
    const morning = receiptLabel(
      { name: "Bruno Costa", paidAt: "2026-09-01T09:00:00Z" },
      "UTC",
    )
    const evening = receiptLabel(
      { name: "Bruno Costa", paidAt: "2026-09-01T17:30:00Z" },
      "UTC",
    )
    expect(morning).toBe("Receipt for Bruno Costa, Sep 1, 2026, 9:00 AM")
    expect(evening).toBe("Receipt for Bruno Costa, Sep 1, 2026, 5:30 PM")
    expect(morning).not.toBe(evening)
  })
})
