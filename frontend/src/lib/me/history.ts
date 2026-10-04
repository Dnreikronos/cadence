import type { PaymentItem } from "@/lib/api/schemas"
import { flattenPayments } from "@/lib/receipts/payments"

export type HistoryView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "list"; items: PaymentItem[] }

type Pages = { pages: readonly { items: readonly PaymentItem[] }[] }

// What the history shows for a paged query. A failure only replaces the screen when
// there is nothing to show: a refresh that fails, or a page that does not load, keeps
// the rows already loaded.
export function historyView(query: {
  data?: Pages
  isError: boolean
}): HistoryView {
  if (!query.data)
    return query.isError ? { kind: "error" } : { kind: "loading" }
  const items = flattenPayments(query.data.pages)
  return items.length === 0 ? { kind: "empty" } : { kind: "list", items }
}

// The announcement after a page loads. Counted on the list as shown, so a payment
// that arrived between pages is not counted twice.
export function loadedMoreMessage(before: number, after: number): string {
  const added = after - before
  if (added <= 0) return "No more payments to load"
  return `Loaded ${added} more ${added === 1 ? "payment" : "payments"}`
}
