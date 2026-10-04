"use client"

import { useMemo, useRef, useState } from "react"
import {
  Download,
  LoaderCircle,
  ReceiptText,
  RotateCw,
  Search,
} from "lucide-react"
import type { PaymentItem } from "@/lib/api/schemas"
import { unitsToUsd } from "@/lib/money"
import {
  useCompanyExport,
  useCompanyPayments,
  useHasAuditor,
} from "@/lib/queries/payments"
import {
  filterPayments,
  flattenPayments,
  isFiltering,
  noFilters,
  statusFilters,
  type PaymentFilters,
  type StatusFilter,
} from "@/lib/receipts/payments"
import { formatPaidDay } from "@/lib/receipts/receipt"
import { cn } from "@/lib/utils"
import { ReceiptDialog } from "@/components/app/receipt-dialog"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { fieldClass } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"

const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_112px_minmax(0,1fr)_176px_88px] md:items-center md:gap-x-4"

const statusLabels: Record<StatusFilter, string> = {
  all: "All statuses",
  confirmed: "Confirmed",
  pending: "Pending",
  failed: "Failed",
}

export function ReceiptsScreen() {
  const payments = useCompanyPayments()
  const exporter = useCompanyExport()
  const [filters, setFilters] = useState<PaymentFilters>(noFilters)
  const hasAuditor = useHasAuditor()
  // The id, not the payment: a refetch that confirms a pending payment updates the open receipt.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const loaded = useMemo(
    () => flattenPayments(payments.data?.pages ?? []),
    [payments.data],
  )
  const selected = useMemo(
    () => loaded.find((payment) => payment.payment_id === selectedId) ?? null,
    [loaded, selectedId],
  )
  const visible = useMemo(
    () => filterPayments(loaded, filters),
    [loaded, filters],
  )

  if (payments.isPending) return <ReceiptsSkeleton />
  if (payments.isError && !payments.data) {
    return (
      <ApiErrorState
        error={payments.error}
        title="Couldn't load your payments"
        onRetry={() => payments.refetch()}
      />
    )
  }

  if (loaded.length === 0) {
    return (
      <EmptyState
        icon={ReceiptText}
        title="No payments yet"
        description="Once you pay someone, the payment and its receipt show up here."
      />
    )
  }

  const filtering = isFiltering(filters)
  const noun = loaded.length === 1 ? "payment" : "payments"

  async function loadMore() {
    const { hasNextPage } = await payments.fetchNextPage()
    // The button is about to go: keep the keyboard on the list.
    if (hasNextPage === false) listRef.current?.focus()
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
          <div className="min-w-0 basis-56">
            <label
              htmlFor="receipts-search"
              className="mb-1 block text-caption text-ink-muted"
            >
              Search by name
            </label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-muted"
              />
              <input
                id="receipts-search"
                ref={searchRef}
                type="search"
                autoComplete="off"
                value={filters.search}
                onChange={(event) =>
                  setFilters({ ...filters, search: event.target.value })
                }
                className={cn(fieldClass, "h-9 pl-8")}
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="receipts-status"
              className="mb-1 block text-caption text-ink-muted"
            >
              Status
            </label>
            <select
              id="receipts-status"
              value={filters.status}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  status: event.target.value as StatusFilter,
                })
              }
              className={cn(fieldClass, "h-9 w-auto")}
            >
              {statusFilters.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          disabled={exporter.isPending}
          aria-busy={exporter.isPending || undefined}
          onClick={() => exporter.mutate()}
          className={buttonVariants({ variant: "secondary" })}
        >
          {exporter.isPending ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="size-4" />
          )}
          {exporter.isPending ? "Preparing CSV…" : "Export CSV"}
        </button>
      </div>

      {exporter.isError && (
        <ApiErrorState
          error={exporter.error}
          title="Couldn't export your payments"
          onRetry={() => exporter.mutate()}
        />
      )}
      {payments.isError && (
        <ApiErrorState
          error={payments.error}
          title={
            payments.isFetchNextPageError
              ? "Couldn't load more payments"
              : "Couldn't refresh your payments"
          }
          onRetry={() =>
            payments.isFetchNextPageError ? loadMore() : payments.refetch()
          }
        />
      )}

      <p aria-live="polite" className="text-ui text-ink-muted">
        {filtering
          ? `${visible.length} of ${loaded.length} loaded ${noun}`
          : `${loaded.length} ${noun}${payments.hasNextPage ? " loaded" : ""}`}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No payments match"
          description={
            payments.hasNextPage
              ? "Only the payments loaded so far are searched. Load more to look further back."
              : "Try another name or status."
          }
          action={
            <button
              type="button"
              onClick={() => {
                setFilters(noFilters)
                // The button that was pressed is about to go.
                searchRef.current?.focus()
              }}
              className={buttonVariants({ variant: "secondary" })}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div
          ref={listRef}
          tabIndex={-1}
          className="overflow-hidden rounded-xl border border-line bg-surface outline-none"
        >
          <div role="table" aria-label="Payments">
            {/* The header stays in the accessibility tree on a phone, where it is not drawn. */}
            <div
              role="row"
              className={`sr-only border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:not-sr-only md:grid ${rowColumns}`}
            >
              <span role="columnheader">Paid to</span>
              <span role="columnheader">Date</span>
              <span role="columnheader" className="flex items-center gap-1">
                Amount
                <WhoCanSee
                  viewerRole="admin"
                  hasAuditor={hasAuditor}
                  note="Payments marked Transparent were sent as ordinary transfers: their amount is public on-chain."
                />
              </span>
              <span role="columnheader">Status</span>
              <span role="columnheader">
                <span className="sr-only">Receipt</span>
              </span>
            </div>
            {visible.map((payment) => (
              <PaymentRow
                key={payment.payment_id}
                payment={payment}
                onOpen={() => setSelectedId(payment.payment_id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col items-center gap-3">
        {payments.hasNextPage && (
          <button
            type="button"
            disabled={payments.isFetchingNextPage}
            aria-busy={payments.isFetchingNextPage || undefined}
            onClick={loadMore}
            className={buttonVariants({ variant: "secondary" })}
          >
            {payments.isFetchingNextPage ? (
              <>
                <RotateCw className="size-4 animate-spin motion-reduce:animate-none" />
                Loading…
              </>
            ) : (
              "Load more"
            )}
          </button>
        )}
        <p className="text-center text-caption text-ink-muted">
          Export CSV saves every payment with its amount, not only the ones
          shown.
        </p>
      </div>

      <ReceiptDialog
        role="admin"
        payment={selected}
        hasAuditor={hasAuditor}
        onClose={() => setSelectedId(null)}
      />
    </section>
  )
}

function PaymentRow({
  payment,
  onOpen,
}: {
  payment: PaymentItem
  onOpen: () => void
}) {
  const day = formatPaidDay(payment.paid_at)
  return (
    <div
      role="row"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-0 md:grid ${rowColumns}`}
    >
      {/* The cells are in reading order, which is also the visual order: on a
          phone the name takes a line and the rest follow it. */}
      <div role="cell" className="min-w-0 basis-full md:basis-auto">
        <p className="text-ui font-medium wrap-break-word text-ink">
          {payment.counterparty.name}
        </p>
        {payment.run_id && (
          <p className="text-caption text-ink-muted">Payroll run</p>
        )}
      </div>
      <div role="cell">
        <time dateTime={payment.paid_at} className="text-ui text-ink-muted">
          {day}
        </time>
      </div>
      <div role="cell">
        <AmountDisplay
          amount={unitsToUsd(payment.amount)}
          className="text-ui"
        />
      </div>
      <div role="cell" className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={payment.status} />
        {payment.transparent && <TransparentBadge />}
      </div>
      <div role="cell" className="ml-auto md:ml-0">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Receipt for ${payment.counterparty.name}, ${day}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <ReceiptText className="size-3.5" />
          Receipt
        </button>
      </div>
    </div>
  )
}

function ReceiptsSkeleton() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading payments</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  )
}
