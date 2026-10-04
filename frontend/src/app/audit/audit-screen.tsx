"use client"

import { useId, useState } from "react"
import { Download, Eye, ReceiptText, Search, Send } from "lucide-react"
import Link from "next/link"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { fieldClass } from "@/components/ui/field"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { isApiError, messageFor } from "@/lib/api/errors"
import { listState, loadedItems } from "@/lib/audit/pages"
import {
  auditRow,
  filterPayments,
  filtersActive,
  isStatusFilter,
  noFilters,
  statusFilters,
  type AuditRow,
  type PaymentFilters,
} from "@/lib/audit/payments"
import { useAuditPayments, useExportAudit } from "@/lib/queries/audit"
import { cn } from "@/lib/utils"
import { ListSkeleton, LoadMore, Time } from "./list-parts"
import { PaymentReceipt } from "./payment-receipt"

const columns =
  "md:grid-cols-[104px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.2fr)_104px] md:items-center md:gap-x-4"

export function AuditScreen({
  companyId,
  company,
}: {
  companyId: string
  company: string
}) {
  const payments = useAuditPayments(companyId)
  const exportCsv = useExportAudit(companyId, company)
  const [filters, setFilters] = useState<PaymentFilters>(noFilters)
  const [receipt, setReceipt] = useState<AuditRow | null>(null)

  const loaded = loadedItems(payments.data)
  const shown = filterPayments(loaded, filters).map(auditRow)
  const state = listState({
    isPending: payments.isPending,
    error: payments.error,
    loaded: loaded.length,
    shown: shown.length,
  })

  return (
    <div className="space-y-4">
      <p className="flex gap-3 rounded-xl border border-line bg-surface p-4 text-ui/normal text-ink">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <span className="min-w-0">
          You can see every amount of{" "}
          <strong className="font-medium wrap-break-word">{company}</strong>.
          Cadence logs every read, and you can review the{" "}
          <Link
            href="/audit/access-log"
            className="underline underline-offset-2"
          >
            access log
          </Link>
          .
        </span>
      </p>

      {state === "loading" && <ListSkeleton label="Loading payments" />}

      {state === "not-found" && (
        <EmptyState
          icon={Search}
          title="Company not found"
          description="We couldn't find that company. It may not be one you audit."
        />
      )}

      {state === "error" && (
        <ErrorState
          title="Couldn't load the payments"
          description={messageFor(payments.error)}
          onRetry={
            !isApiError(payments.error) || payments.error.isRetryable
              ? () => payments.refetch()
              : undefined
          }
        />
      )}

      {state === "empty" && (
        <EmptyState
          icon={Send}
          title="No payments yet"
          description={`${company} hasn't made a payment yet. They appear here as they happen.`}
        />
      )}

      {(state === "ready" || state === "no-match") && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Filters filters={filters} onChange={setFilters} />
            <button
              type="button"
              disabled={exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
              className={buttonVariants({
                variant: "secondary",
                className: "md:ml-auto",
              })}
            >
              <Download className="size-4" />
              {exportCsv.isPending ? "Exporting…" : "Export CSV"}
            </button>
          </div>
          {filtersActive(filters) && payments.hasNextPage && (
            <p className="text-caption text-ink-muted">
              Filters apply to the {loaded.length} payments loaded so far. Load
              more to search further.
            </p>
          )}

          {state === "no-match" ? (
            <EmptyState
              icon={Search}
              title="No payments match"
              description="Nothing loaded matches these filters."
              action={
                <button
                  type="button"
                  onClick={() => setFilters(noFilters)}
                  className={buttonVariants({ variant: "secondary" })}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <PaymentList rows={shown} onReceipt={setReceipt} />
          )}

          <LoadMore
            hasMore={payments.hasNextPage}
            loading={payments.isFetchingNextPage}
            error={payments.isFetchNextPageError ? payments.error : null}
            onLoad={() => payments.fetchNextPage()}
          />
        </section>
      )}

      <PaymentReceipt
        row={receipt}
        company={company}
        onClose={() => setReceipt(null)}
      />
    </div>
  )
}

function Filters({
  filters,
  onChange,
}: {
  filters: PaymentFilters
  onChange: (filters: PaymentFilters) => void
}) {
  const id = useId()
  return (
    <>
      <div className="min-w-0 flex-1 basis-48">
        <label
          htmlFor={`${id}-search`}
          className="mb-1.5 block text-caption font-medium text-ink"
        >
          Paid to
        </label>
        <input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          placeholder="Search by name"
          value={filters.search}
          onChange={(event) =>
            onChange({ ...filters, search: event.target.value })
          }
          className={cn(fieldClass, "h-9")}
        />
      </div>
      <div className="min-w-0 basis-40">
        <label
          htmlFor={`${id}-status`}
          className="mb-1.5 block text-caption font-medium text-ink"
        >
          Status
        </label>
        <select
          id={`${id}-status`}
          value={filters.status}
          onChange={(event) => {
            const { value } = event.target
            if (isStatusFilter(value)) onChange({ ...filters, status: value })
          }}
          className={cn(fieldClass, "h-9")}
        >
          {statusFilters.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

function PaymentList({
  rows,
  onReceipt,
}: {
  rows: AuditRow[]
  onReceipt: (row: AuditRow) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div
        className={`hidden border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${columns}`}
      >
        <span>Date</span>
        <span>Paid to</span>
        <span className="flex items-center gap-1">
          Amount
          <WhoCanSee viewerRole="auditor" hasAuditor />
        </span>
        <span>Status</span>
        <span className="sr-only">Receipt</span>
      </div>
      <ul>
        {rows.map((row) => (
          <li
            key={row.id}
            className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-0 ${columns}`}
          >
            <span className="order-2 text-caption text-ink-muted md:order-0 md:text-ui">
              <Time iso={row.paidAt} />
            </span>
            <span className="order-1 min-w-0 text-ui font-medium wrap-break-word text-ink md:order-0 md:font-normal">
              {row.name}
            </span>
            <span className="order-3 inline-flex items-center gap-1.5 text-ui md:order-0">
              <AmountDisplay amount={row.usd} />
              <WhoCanSee
                viewerRole="auditor"
                hasAuditor
                className="md:hidden"
              />
            </span>
            <span className="order-4 flex flex-wrap items-center justify-end gap-1.5 md:order-0 md:justify-start">
              <StatusPill status={row.status} />
              {row.transparent && <TransparentBadge />}
            </span>
            <span className="order-5 col-span-2 flex md:order-0 md:col-span-1 md:justify-end">
              <button
                type="button"
                onClick={() => onReceipt(row)}
                aria-label={`Receipt for ${row.name}, ${row.paidAt.slice(0, 10)}`}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <ReceiptText className="size-3.5" />
                Receipt
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
