"use client"

import { useRef, useState } from "react"
import { Download, Loader2, Wallet } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { messageFor } from "@/lib/api/errors"
import { exportReaders } from "@/lib/me/copy"
import { historyView, loadedMoreMessage } from "@/lib/me/history"
import { useExportPayments, usePaymentHistory } from "@/lib/queries/me"
import { PaymentList, PaymentListSkeleton } from "../../payment-list"

export function HistoryScreen() {
  return (
    <div className="max-w-3xl">
      <HistoryBody />
    </div>
  )
}

function HistoryBody() {
  const history = usePaymentHistory()
  const listRef = useRef<HTMLUListElement>(null)
  const [announcement, setAnnouncement] = useState("")
  const view = historyView(history)

  if (view.kind === "loading") return <PaymentListSkeleton rows={5} />
  if (view.kind === "error") {
    return (
      <ApiErrorState
        error={history.error}
        title="Couldn't load your payments"
        onRetry={() => history.refetch()}
      />
    )
  }
  if (view.kind === "empty") {
    return (
      <EmptyState
        icon={Wallet}
        title="Nothing received yet"
        description="Payments sent to you appear here once they land."
      />
    )
  }

  const { items } = view

  async function loadMore() {
    if (history.isFetchingNextPage) return
    const before = items.length
    const result = await history.fetchNextPage()
    if (result.isError) return
    const loaded = result.data
      ? historyView({ data: result.data, isError: false })
      : null
    setAnnouncement(
      loadedMoreMessage(
        before,
        loaded?.kind === "list" ? loaded.items.length : before,
      ),
    )
    // The button is about to go: keep the keyboard on the list.
    if (result.hasNextPage === false) listRef.current?.focus()
  }

  return (
    <div className="space-y-4">
      <ExportBar />
      <PaymentList items={items} listRef={listRef} />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {history.isFetchNextPageError && (
        <ApiErrorState
          error={history.error}
          title="Couldn't load more payments"
          onRetry={() => void loadMore()}
        />
      )}
      {history.hasNextPage && !history.isFetchNextPageError && (
        <div className="flex justify-center">
          {/* aria-disabled, not disabled: a disabled button drops the keyboard's place. */}
          <button
            type="button"
            aria-disabled={history.isFetchingNextPage || undefined}
            aria-busy={history.isFetchingNextPage || undefined}
            onClick={() => void loadMore()}
            className={buttonVariants({
              variant: "secondary",
              className: "aria-disabled:opacity-50",
            })}
          >
            {history.isFetchingNextPage && (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  )
}

function ExportBar() {
  const exporting = useExportPayments()
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-1 basis-64 items-start gap-1.5 text-caption/normal text-ink-muted">
          <WhoCanSee
            viewerRole="recipient"
            hasAuditor={undefined}
            label="Who can see the amounts in this file"
            description={exportReaders}
            note="Keep the file safe: it contains your amounts."
            className="-mt-1"
          />
          <span>
            The CSV lists every payment with its amount in plain text. Cadence
            logs each export.
          </span>
        </p>
        <button
          type="button"
          // Not `disabled`: that would drop focus to the page while it exports.
          aria-disabled={exporting.isPending || undefined}
          onClick={() => {
            if (!exporting.isPending) exporting.mutate()
          }}
          className={buttonVariants({
            variant: "secondary",
            className: "aria-disabled:opacity-50",
          })}
        >
          {exporting.isPending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="size-4" />
          )}
          {exporting.isPending
            ? "Exporting…"
            : exporting.isError
              ? "Try export again"
              : "Export CSV"}
        </button>
      </div>
      {exporting.isError && (
        <p role="alert" className="text-ui text-danger-fg">
          {messageFor(exporting.error)}
        </p>
      )}
    </div>
  )
}
