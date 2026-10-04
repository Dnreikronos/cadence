"use client"

import { useId, useState } from "react"
import { Download, Eye, ReceiptText, Search, Send } from "lucide-react"
import Link from "next/link"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { fieldClass } from "@/components/ui/field"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { listState, loadedItems, showFilterNote } from "@/lib/audit/pages"
import {
  auditRow,
  filterPayments,
  filtersActive,
  isStatusFilter,
  noFilters,
  receiptLabel,
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
  const noteId = useId()
  const exportNoteId = useId()

  const loaded = loadedItems(payments.data)
  const shown = filterPayments(loaded, filters).map(auditRow)
  const state = listState({
    isPending: payments.isPending,
    error: payments.error,
    loaded: loaded.length,
    shown: shown.length,
    companyScoped: true,
  })
  const noteShown = showFilterNote(filtersActive(filters), payments.hasNextPage)

  return (
    <div className="space-y-4">
      <p className="flex gap-3 rounded-xl border border-line bg-surface p-4 text-ui/normal text-ink">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <span className="min-w-0">
          You can see every amount of{" "}
          <strong className="font-medium wrap-break-word">{company}</strong>.
          Cadence logs every read, including yours; the{" "}
          <Link
            href="/audit/access-log"
            className="underline underline-offset-2"
          >
            access log
          </Link>{" "}
          lists them.
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
        <ApiErrorState
          error={payments.error}
          title="Couldn't load the payments"
          onRetry={() => payments.refetch()}
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
            <Filters
              filters={filters}
              onChange={setFilters}
              describedBy={noteShown ? noteId : undefined}
            />
            <button
              type="button"
              aria-describedby={exportNoteId}
              aria-disabled={exportCsv.isPending || undefined}
              onClick={() => {
                if (!exportCsv.isPending) exportCsv.mutate()
              }}
              className={buttonVariants({
                variant: "secondary",
                className: "aria-disabled:opacity-50 md:ml-auto",
              })}
            >
              <Download className="size-4" />
              {exportCsv.isPending ? "Exporting…" : "Export all payments (CSV)"}
            </button>
          </div>
          <p id={exportNoteId} className="text-caption text-ink-muted">
            The CSV holds every payment with its amount, whatever the filters
            show.
          </p>
          <p id={noteId} role="status" className="text-caption text-ink-muted">
            {noteShown
              ? `Filters apply to the ${loaded.length} payments loaded so far. Load more to search further.`
              : null}
          </p>

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
            <PaymentTable rows={shown} onReceipt={setReceipt} />
          )}

          <LoadMore
            noun="payments"
            count={loaded.length}
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
  describedBy,
}: {
  filters: PaymentFilters
  onChange: (filters: PaymentFilters) => void
  describedBy?: string
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
          aria-describedby={describedBy}
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
          aria-describedby={describedBy}
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

// A table for assistive technology at every width. Its header is only drawn from md up; below
// that it stays in the accessibility tree, and the cells stack in reading order.
function PaymentTable({
  rows,
  onReceipt,
}: {
  rows: AuditRow[]
  onReceipt: (row: AuditRow) => void
}) {
  return (
    <div
      role="table"
      aria-label="Payments"
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div
        role="row"
        className={`sr-only text-label text-ink-muted uppercase md:not-sr-only md:grid md:border-b md:border-line md:bg-surface-subtle md:px-4 md:py-2 ${columns}`}
      >
        <span role="columnheader">Date</span>
        <span role="columnheader">Paid to</span>
        <span role="columnheader" className="flex items-center gap-1">
          Amount
          <span className="hidden md:inline-flex">
            <WhoCanSee viewerRole="auditor" hasAuditor />
          </span>
        </span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="sr-only">
          Receipt
        </span>
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          role="row"
          className={`grid gap-y-1.5 border-b border-line px-4 py-3 last:border-0 ${columns}`}
        >
          <span role="cell" className="text-caption text-ink-muted md:text-ui">
            <Time iso={row.paidAt} />
          </span>
          <span
            role="cell"
            className="min-w-0 text-ui font-medium wrap-break-word text-ink md:font-normal"
          >
            {row.name}
          </span>
          <span
            role="cell"
            className="inline-flex items-center gap-1.5 text-ui"
          >
            <AmountDisplay amount={row.usd} />
            <WhoCanSee viewerRole="auditor" hasAuditor className="md:hidden" />
          </span>
          <span role="cell" className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={row.status} />
            {row.transparent && <TransparentBadge />}
          </span>
          <span role="cell" className="flex md:justify-end">
            <button
              type="button"
              onClick={() => onReceipt(row)}
              aria-label={receiptLabel(row)}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <ReceiptText className="size-3.5" />
              Receipt
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
