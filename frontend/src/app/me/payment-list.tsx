"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import type { PaymentItem } from "@/lib/api/schemas"
import { initialsOf } from "@/lib/me/payments"
import { formatPaidDay } from "@/lib/receipts/receipt"
import { unitsToUsd } from "@/lib/money"
import { ReceiptDialog } from "@/components/app/receipt-dialog"

// Payments the recipient received, each opening its receipt. Used by the home
// page (latest few) and the history page (all of them).
export function PaymentList({ items }: { items: PaymentItem[] }) {
  const [open, setOpen] = useState<PaymentItem | null>(null)
  return (
    <>
      <ul className="overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((payment) => (
          <li
            key={payment.payment_id}
            className="border-b border-line last:border-0"
          >
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setOpen(payment)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
            >
              <AvatarPerson
                initials={initialsOf(payment.counterparty.name)}
                size={32}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-ink">
                  {payment.counterparty.name}
                </span>
                <time
                  dateTime={payment.paid_at}
                  className="block text-caption text-ink-muted"
                >
                  {formatPaidDay(payment.paid_at)}
                </time>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <AmountDisplay
                  amount={unitsToUsd(payment.amount)}
                  className="text-ui"
                />
                <span className="flex flex-wrap justify-end gap-1">
                  <StatusPill status={payment.status} />
                  {payment.transparent && <TransparentBadge />}
                </span>
              </span>
              <ChevronRight
                aria-hidden
                className="hidden size-4 shrink-0 text-ink-muted sm:block"
              />
              <span className="sr-only">View receipt</span>
            </button>
          </li>
        ))}
      </ul>
      <ReceiptDialog
        role="recipient"
        payment={open}
        onClose={() => setOpen(null)}
      />
    </>
  )
}

export function PaymentListSkeleton({ rows }: { rows: number }) {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading payments</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  )
}
