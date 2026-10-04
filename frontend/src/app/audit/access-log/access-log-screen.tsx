"use client"

import { ScrollText, ShieldCheck } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { isApiError, messageFor } from "@/lib/api/errors"
import { accessRow } from "@/lib/audit/access-log"
import { listState, loadedItems } from "@/lib/audit/pages"
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
          Every time an amount of{" "}
          <strong className="font-medium wrap-break-word">{company}</strong> is
          decrypted, by the company, a recipient, an auditor or Cadence&apos;s
          service, the read is recorded here with who did it. Cadence can read
          amounts too, which is why its reads are listed. Opening this log
          decrypts nothing, so it does not add a row.
        </span>
      </p>

      {state === "loading" && <ListSkeleton label="Loading the access log" />}

      {state === "not-found" && (
        <EmptyState
          icon={ScrollText}
          title="Nothing to show"
          description="We couldn't find an access log for this account."
        />
      )}

      {state === "error" && (
        <ErrorState
          title="Couldn't load the access log"
          description={messageFor(log.error)}
          onRetry={
            !isApiError(log.error) || log.error.isRetryable
              ? () => log.refetch()
              : undefined
          }
        />
      )}

      {state === "empty" && (
        <EmptyState
          icon={ScrollText}
          title="No reads recorded yet"
          description="Reads appear here as soon as someone decrypts an amount."
        />
      )}

      {state === "ready" && (
        <section className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div
              className={`hidden border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${columns}`}
            >
              <span>When</span>
              <span>Who</span>
              <span>What</span>
              <span>Scope</span>
            </div>
            <ul>
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={`grid gap-y-0.5 border-b border-line px-4 py-3 text-ui last:border-0 ${columns}`}
                >
                  <span className="text-caption text-ink-muted md:text-ui">
                    <Time iso={row.at} format={timeFormat} />
                  </span>
                  <span className="min-w-0 wrap-break-word text-ink">
                    <span className="font-medium">{row.who}</span>
                    <span className="text-ink-muted"> · {row.kind}</span>
                  </span>
                  <span className="min-w-0 wrap-break-word text-ink">
                    {row.action}
                  </span>
                  <span className="min-w-0 wrap-break-word text-ink-muted">
                    {row.scope}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <LoadMore
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
