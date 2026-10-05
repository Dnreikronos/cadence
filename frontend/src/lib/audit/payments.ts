import {
  knownPaymentStatus,
  type PaymentItem,
  type PaymentItemStatus,
} from "@/lib/api/schemas"
import { unitsToUsd } from "@/lib/money"

type ItemStatus = PaymentItemStatus

export type PaymentFilters = { status: ItemStatus | "all"; search: string }

export const noFilters: PaymentFilters = { status: "all", search: "" }

export const statusFilters: {
  value: PaymentFilters["status"]
  label: string
}[] = [
  { value: "all", label: "All statuses" },
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
]

export function isStatusFilter(
  value: string,
): value is PaymentFilters["status"] {
  return statusFilters.some((filter) => filter.value === value)
}

export function filtersActive(filters: PaymentFilters) {
  return filters.status !== "all" || filters.search.trim() !== ""
}

// Filters run over what has been loaded: the service pages by cursor and has no filter parameters.
export function filterPayments(
  items: readonly PaymentItem[],
  { status, search }: PaymentFilters,
) {
  const needle = search.trim().toLowerCase()
  return items.filter(
    (item) =>
      (status === "all" || knownPaymentStatus(item.status) === status) &&
      (needle === "" || item.counterparty.name.toLowerCase().includes(needle)),
  )
}

// What a row shows: the amount in dollars for display only, everything else as sent.
export type AuditRow = {
  id: string
  name: string
  usd: number
  status: ItemStatus
  transparent: boolean
  paidAt: string
  signature: string | null
}

export function auditRow(item: PaymentItem): AuditRow {
  return {
    id: item.payment_id,
    name: item.counterparty.name,
    usd: unitsToUsd(item.amount),
    status: knownPaymentStatus(item.status),
    transparent: item.transparent,
    paidAt: item.paid_at,
    signature: item.signature,
  }
}

const receiptTime = (timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  })

// Two payments to one person on one day must not read alike to a screen reader.
export function receiptLabel(
  row: Pick<AuditRow, "name" | "paidAt">,
  timeZone?: string,
) {
  return `Receipt for ${row.name}, ${receiptTime(timeZone).format(new Date(row.paidAt))}`
}
