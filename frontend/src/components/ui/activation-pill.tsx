import { cn } from "@/lib/utils"
import type { Activation } from "@/lib/people/types"

const pills: Record<
  Activation,
  { label: string; className: string; dot: string }
> = {
  active: {
    label: "Active",
    className: "border-success-border bg-success-bg text-success-fg",
    dot: "bg-success-dot",
  },
  invited: {
    label: "Invite sent",
    className: "border-pending/40 text-ink",
    dot: "bg-pending",
  },
  "invite-expired": {
    label: "Invite expired",
    className: "border-warning-border bg-warning-bg text-warning-fg",
    dot: "bg-warning-dot",
  },
  "not-invited": {
    label: "Not invited",
    className: "border-line text-ink-muted",
    dot: "bg-ink-muted/50",
  },
}

export function ActivationPill({
  activation,
  className,
}: {
  activation: Activation
  className?: string
}) {
  const pill = pills[activation]
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
