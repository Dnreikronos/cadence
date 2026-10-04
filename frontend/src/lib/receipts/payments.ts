import type { PaymentItem } from "@/lib/api/schemas"

export const statusFilters = ["all", "confirmed", "pending", "failed"] as const
export type StatusFilter = (typeof statusFilters)[number]

export type PaymentFilters = { status: StatusFilter; search: string }

export const noFilters: PaymentFilters = { status: "all", search: "" }

export function isFiltering(filters: PaymentFilters) {
  return filters.status !== "all" || filters.search.trim() !== ""
}

// Client-side, over the pages loaded so far: the service has no filter parameters.
export function filterPayments(
  payments: readonly PaymentItem[],
  filters: PaymentFilters,
): PaymentItem[] {
  const needle = filters.search.trim().toLocaleLowerCase()
  return payments.filter(
    (payment) =>
      (filters.status === "all" || payment.status === filters.status) &&
      (needle === "" ||
        payment.counterparty.name.toLocaleLowerCase().includes(needle)),
  )
}
