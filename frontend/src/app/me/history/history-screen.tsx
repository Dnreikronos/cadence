"use client"

import { Download, Loader2, Wallet } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { messageFor } from "@/lib/api/errors"
import { useExportPayments, usePaymentHistory } from "@/lib/queries/me"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { PaymentList, PaymentListSkeleton } from "../payment-list"

export function HistoryScreen() {
  return (
    <div className="max-w-3xl">
      <HistoryBody />
    </div>
  )
}

function HistoryBody() {
  const history = usePaymentHistory()

  if (!history.data && !history.isError) return <PaymentListSkeleton rows={5} />
  if (!history.data) {
    return (
      <ErrorState
        title="Couldn't load your payments"
        description={messageFor(history.error)}
        onRetry={() => history.refetch()}
      />
    )
  }

  const items = history.data.pages.flatMap((page) => page.items)
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Nothing received yet"
        description="Payments sent to you appear here once they land."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ExportBar />
      <PaymentList items={items} />
      {history.isFetchNextPageError && (
        <ErrorState
          title="Couldn't load more payments"
          description={messageFor(history.error)}
          onRetry={() => history.fetchNextPage()}
        />
      )}
      {history.hasNextPage && !history.isFetchNextPageError && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
            className={buttonVariants({ variant: "secondary" })}
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
            className="-mt-1"
          />
          <span>
            The CSV lists every payment with its amount in plain text. Cadence
            logs each export.
          </span>
        </p>
        <button
          type="button"
          disabled={exporting.isPending}
          onClick={() => exporting.mutate()}
          className={buttonVariants({ variant: "secondary" })}
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
