import { cn } from "@/lib/utils"
import type { RowStatus } from "@/lib/runs/progress"

// `StatusPill` has the three states of a payment in a list; a payment in a run also
// has the two this browser adds while it signs, `cancelled` and `expired`.
const pills: Record<
  RowStatus,
  { label: string; className: string; dot: string }
> = {
  pending: {
    label: "Pending",
    className: "border-line text-ink-muted",
    dot: "bg-ink-muted/50",
  },
  signing: {
    label: "Signing",
    className: "border-pending/40 text-ink",
    dot: "bg-pending animate-pulse motion-reduce:animate-none",
  },
  waiting: {
    label: "Waiting",
    className: "border-pending/40 text-ink",
    dot: "bg-pending animate-pulse motion-reduce:animate-none",
  },
  unknown: {
    label: "Check needed",
    className: "border-warning-border bg-warning-bg text-warning-fg",
    dot: "bg-warning-dot",
  },
  unrecognized: {
    label: "Unknown",
    className: "border-line text-ink-muted",
    dot: "bg-ink-muted/50",
  },
  cancelled: {
    label: "Not signed",
    className: "border-warning-border bg-warning-bg text-warning-fg",
    dot: "bg-warning-dot",
  },
  confirmed: {
    label: "Confirmed",
    className: "border-success-border bg-success-bg text-success-fg",
    dot: "bg-success-dot",
  },
  failed: {
    label: "Failed",
    className: "border-danger-border bg-danger-bg text-danger-fg",
    dot: "bg-danger-dot",
  },
  expired: {
    label: "Expired",
    className: "border-warning-border bg-warning-bg text-warning-fg",
    dot: "bg-warning-dot",
  },
}

export function RunStatusPill({
  status,
  className,
}: {
  status: RowStatus
  className?: string
}) {
  const pill = pills[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] whitespace-nowrap",
        pill.className,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", pill.dot)} />
      {pill.label}
    </span>
  )
}
