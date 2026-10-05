import { Link2, Link2Off } from "lucide-react"
import type { RevealRiskLevel } from "@/lib/api/schemas"
import { riskView } from "@/lib/withdraw/risk"
import { cn } from "@/lib/utils"

// Whether this withdrawal can be linked to a payment the person received. Shown at
// every level, but only a match is styled as a warning.
export function RevealRiskBadge({
  level,
  className,
}: {
  level: RevealRiskLevel
  className?: string
}) {
  const view = riskView(level)
  const Icon = view.isWarning ? Link2 : Link2Off
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] whitespace-nowrap",
        view.isWarning
          ? "border-warning-border bg-warning-bg text-warning-fg"
          : "border-line bg-surface text-ink-muted",
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">Link to a payment: </span>
      {view.label}
    </span>
  )
}
