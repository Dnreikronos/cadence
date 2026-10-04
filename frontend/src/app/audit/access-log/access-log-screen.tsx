"use client"

import { ScrollText, ShieldCheck } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { messageFor } from "@/lib/api/errors"
import { accessRow } from "@/lib/audit/access-log"
import { canRetry, listState, loadedItems } from "@/lib/audit/pages"
import { useAccessLog } from "@/lib/queries/audit"
import { ListSkeleton, LoadMore, Time, timeFormat } from "../list-parts"

const columns =
  "md:grid-cols-[168px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-x-4"

export function AccessLogScreen({ company }: { company: string }) {
  const log = useAccessLog()
  const rows = loadedItems(log.data).map(accessRow)
  const state = listState({
    isPending: log.isPending,
    error: log.error,
    loaded: rows.length,
    shown: rows.length,
  })

  return (
    <div className="space-y-4">
      <p className="flex gap-3 rounded-xl border border-line bg-surface p-4 text-ui/normal text-ink">
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-ink-muted"
        />
        <span className="min-w-0">
          Cadence records reads of{" "}
          <strong className="font-medium wrap-break-word">{company}</strong>
          &apos;s data here: who read, when, and what kind of data. Cadence can
          read amounts too, so its reads are listed with the others. An entry
          names the data read, never an amount.
        </span>
      </p>

      {state === "loading" && <ListSkeleton label="Loading the access log" />}

      {state === "error" && (
        <ErrorState
          title="Couldn't load the access log"
          description={messageFor(log.error)}
          onRetry={canRetry(log.error) ? () => log.refetch() : undefined}
        />
      )}

      {state === "empty" && (
        <EmptyState
          icon={ScrollText}
          title="No reads recorded yet"
          description="Reads of the company's data appear here once someone has made one."
        />
      )}

      {state === "ready" && (
        <section className="space-y-4">
          <div
            role="table"
            aria-label="Access log"
            className="overflow-hidden rounded-xl border border-line bg-surface"
          >
            <div
              role="row"
              className={`sr-only text-label text-ink-muted uppercase md:not-sr-only md:grid md:border-b md:border-line md:bg-surface-subtle md:px-4 md:py-2 ${columns}`}
            >
              <span role="columnheader">When</span>
              <span role="columnheader">Who</span>
              <span role="columnheader">What</span>
              <span role="columnheader">Scope</span>
            </div>
            {rows.map((row) => (
              <div
                key={row.key}
                role="row"
                className={`grid gap-y-0.5 border-b border-line px-4 py-3 text-ui last:border-0 ${columns}`}
              >
                <span
                  role="cell"
                  className="text-caption text-ink-muted md:text-ui"
                >
                  <Time iso={row.at} format={timeFormat} />
                </span>
                <span role="cell" className="min-w-0 wrap-break-word text-ink">
                  <span className="font-medium">{row.who}</span>
                  <span className="text-ink-muted"> · {row.kind}</span>
                </span>
                <span role="cell" className="min-w-0 wrap-break-word text-ink">
                  {row.action}
                </span>
                <span
                  role="cell"
                  className="min-w-0 wrap-break-word text-ink-muted"
                >
                  {row.scope}
                </span>
              </div>
            ))}
          </div>
          <LoadMore
            noun="entries"
            count={rows.length}
            hasMore={log.hasNextPage}
            loading={log.isFetchingNextPage}
            error={log.isFetchNextPageError ? log.error : null}
            onLoad={() => log.fetchNextPage()}
          />
        </section>
      )}
    </div>
  )
}
