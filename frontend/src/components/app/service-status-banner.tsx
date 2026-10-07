import { CircleAlert, TriangleAlert } from "lucide-react"
import type { ServiceStatus } from "@/lib/queries/health"
import { cn } from "@/lib/utils"

const copy = {
  down: {
    icon: CircleAlert,
    title: "Can't reach Cadence",
    description:
      "Balances and payments won't load until it's back. Check your connection; this page checks again on its own.",
    className: "border-danger-border bg-danger-bg text-danger-fg",
  },
  degraded: {
    icon: TriangleAlert,
    title: "Cadence can't reach the network",
    description:
      "Balances may not load and payments can't be sent until it's back. This page checks again on its own.",
    className: "border-warning-border bg-warning-bg text-warning-fg",
  },
} satisfies Record<ServiceStatus, unknown>

// Above every signed-in screen while the health check reports a problem; nothing when the
// service is fine. A status, not an alert: nobody asked, and it never offers a button.
export function ServiceStatusBanner({
  status,
  className,
}: {
  status: ServiceStatus | null
  className?: string
}) {
  if (!status) return null
  const { icon: Icon, title, description, className: tone } = copy[status]
  return (
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-xl border p-3 print:hidden",
        tone,
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-ui font-medium">{title}</p>
        <p className="mt-0.5 text-ui/normal">{description}</p>
      </div>
    </div>
  )
}
