import { RotateCw } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { messageFor } from "@/lib/api/errors"

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
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoad,
}: {
  hasMore: boolean
  loading: boolean
  error: unknown
  onLoad: () => void
}) {
  if (!hasMore && !error) return null
  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      {error ? (
        <p role="alert" className="text-ui text-danger-fg">
          {messageFor(error)}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className={buttonVariants({ variant: "secondary" })}
      >
        {error ? <RotateCw className="size-3.5" /> : null}
        {loading ? "Loading…" : error ? "Try again" : "Load more"}
      </button>
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
