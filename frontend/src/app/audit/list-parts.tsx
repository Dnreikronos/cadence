"use client"

import { useEffect, useRef, useState } from "react"
import { RotateCw } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { messageFor } from "@/lib/api/errors"
import { loadedMessage } from "@/lib/audit/pages"

export const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export const timeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function Time({
  iso,
  format = dayFormat,
}: {
  iso: string
  format?: Intl.DateTimeFormat
}) {
  return <time dateTime={iso}>{format.format(new Date(iso))}</time>
}

// "Load more" for a cursor-paged list. A failed page keeps the loaded rows and says so here.
// Focus must never fall to the page: the button stays focusable while loading (aria-disabled,
// not disabled), and on the last page focus moves to the "all loaded" line that replaces it.
export function LoadMore({
  noun,
  count,
  hasMore,
  loading,
  error,
  onLoad,
}: {
  // Plural, for "All payments loaded".
  noun: string
  count: number
  hasMore: boolean
  loading: boolean
  error: unknown
  onLoad: () => void
}) {
  const buttonFocused = useRef(false)
  const doneLine = useRef<HTMLParagraphElement>(null)

  // "Loaded N more" for screen readers, set while rendering from the change in count.
  const [seen, setSeen] = useState(count)
  const [announcement, setAnnouncement] = useState("")
  if (count !== seen) {
    setSeen(count)
    setAnnouncement(loadedMessage(seen, count))
  }

  useEffect(() => {
    if (!hasMore && buttonFocused.current) {
      buttonFocused.current = false
      doneLine.current?.focus()
    }
  }, [hasMore])

  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      {error ? (
        <p role="alert" className="text-ui text-danger-fg">
          {messageFor(error)}
        </p>
      ) : null}
      {hasMore ? (
        <button
          type="button"
          aria-disabled={loading || undefined}
          onFocus={() => (buttonFocused.current = true)}
          onBlur={() => (buttonFocused.current = false)}
          onClick={() => {
            if (!loading) onLoad()
          }}
          className={buttonVariants({
            variant: "secondary",
            className: "aria-disabled:opacity-50",
          })}
        >
          {error ? <RotateCw className="size-3.5" /> : null}
          {loading ? "Loading…" : error ? "Try again" : "Load more"}
        </button>
      ) : count > 0 ? (
        <p
          ref={doneLine}
          tabIndex={-1}
          className="text-caption text-ink-muted outline-none"
        >
          All {noun} loaded
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

export function ListSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-0"
        >
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  )
}
