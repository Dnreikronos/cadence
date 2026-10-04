import { knownPaymentStatus } from "@/lib/api/schemas"
import { cn } from "@/lib/utils"

export type PaymentStatus = "pending" | "confirmed" | "failed"

const pills: Record<
  PaymentStatus,
  { label: string; className: string; dot: string }
> = {
  pending: {
    label: "Pending",
    className: "border-pending/40 text-ink",
    dot: "bg-pending animate-pulse motion-reduce:animate-none",
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
}

// Whether a payment went out confidentially is a separate axis: see TransparentBadge.
export function StatusPill({
  status,
  className,
}: {
  // Any string: a status the client does not know shows as pending.
  status: string
  className?: string
}) {
  const pill = pills[knownPaymentStatus(status)]
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
