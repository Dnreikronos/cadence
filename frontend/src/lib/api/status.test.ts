import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { StatusPill } from "@/components/ui/status-pill"
import { filterPayments as filterAudit } from "@/lib/audit/payments"
import { filterPayments, noFilters } from "@/lib/receipts/payments"
import { receiptSummary } from "@/lib/receipts/receipt"
import { recentlyPaidIds } from "@/lib/runs/plan"
import { createApiClient } from "./client"
import {
  isKnownRunPaymentStatus,
  knownPaymentStatus,
  paymentItemSchema,
  paymentItemStatuses,
  runPaymentStatuses,
  runSchema,
} from "./schemas"

const GUID = "a0000000-0000-4000-8000-000000000001"

function clientFor(body: unknown) {
  return createApiClient({
    baseUrl: "https://api.cadence.test",
    getToken: async () => "token",
    fetch: (async () => Response.json(body)) as typeof globalThis.fetch,
  })
}

const item = (status: unknown) => ({
  payment_id: GUID,
  run_id: null,
  counterparty: { id: GUID, name: "Bruno Costa" },
  amount: "1000000",
  status,
  transparent: false,
  paid_at: "2026-09-01T12:00:00Z",
  signature: null,
})

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const run = (status: unknown) => ({
  run_id: GUID,
  company_wallet: WALLET,
  sender: WALLET,
  mint: WALLET,
  transaction_version: 1,
  required_signers: [WALLET],
  status: "prepared",
  payments: [
    {
      position: 0,
      destination: WALLET,
      attempt: 0,
      request_id: null,
      status,
      signature: null,
      slot: null,
      error: null,
    },
  ],
})

describe("an unknown payment status", () => {
  it("parses on a payment item instead of failing the response", async () => {
    const api = clientFor({ items: [item("refunded")], next_cursor: null })
    const page = await api.company.payments()
    expect(page.items[0].status).toBe("refunded")
    expect(knownPaymentStatus(page.items[0].status)).toBe("pending")
  })

  it("parses on a payment in a run", async () => {
    const api = clientFor(run("reversed"))
    const read = await api.runs.get(GUID)
    expect(read.payments[0].status).toBe("reversed")
    expect(isKnownRunPaymentStatus(read.payments[0].status)).toBe(false)
  })

  it("still refuses a status that is not a non-empty string", () => {
    for (const status of [null, 5, "", undefined, {}]) {
      expect(paymentItemSchema.safeParse(item(status)).success).toBe(false)
      expect(runSchema.safeParse(run(status)).success).toBe(false)
    }
  })

  it("keeps every known value as it is", () => {
    for (const status of paymentItemStatuses) {
      expect(knownPaymentStatus(status)).toBe(status)
    }
    for (const status of runPaymentStatuses) {
      expect(isKnownRunPaymentStatus(status)).toBe(true)
    }
  })

  it("is pending, never confirmed or failed, wherever a status decides", () => {
    // Words that look like a known status but are not one of them.
    for (const status of [
      "Confirmed",
      "FAILED",
      "settled",
      "expired",
      "signed",
    ]) {
      expect(knownPaymentStatus(status), status).toBe("pending")
    }
    expect(isKnownRunPaymentStatus("settled")).toBe(false)
    expect(isKnownRunPaymentStatus("Finalized")).toBe(false)

    expect(receiptSummary({ status: "refunded", transparent: false })).toBe(
      "Waiting for the network to confirm.",
    )
    // It may have paid the person, so the repay guard unticks them (see plan.test.ts).
    const parsed = paymentItemSchema.parse(item("refunded"))
    expect(
      recentlyPaidIds([parsed], Date.parse("2026-09-01T13:00:00Z")).size,
    ).toBe(1)
  })

  it("is found by the pending filter and by no other", () => {
    const parsed = paymentItemSchema.parse(item("refunded"))
    expect(
      filterPayments([parsed], { ...noFilters, status: "pending" }),
    ).toEqual([parsed])
    expect(filterAudit([parsed], { status: "pending", search: "" })).toEqual([
      parsed,
    ])
    for (const status of ["confirmed", "failed"] as const) {
      expect(filterPayments([parsed], { ...noFilters, status })).toEqual([])
      expect(filterAudit([parsed], { status, search: "" })).toEqual([])
    }
  })

  it("renders as the neutral pending pill", () => {
    const unknown = renderToStaticMarkup(
      createElement(StatusPill, { status: "refunded" }),
    )
    const pending = renderToStaticMarkup(
      createElement(StatusPill, { status: "pending" }),
    )
    expect(unknown).toBe(pending)
    expect(unknown).toContain("Pending")
    expect(unknown).not.toMatch(/Confirmed|Failed|success|danger/)
  })
})
