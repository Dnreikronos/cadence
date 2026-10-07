import { CircleAlert, TriangleAlert } from "lucide-react"
import { Notice } from "@/components/ui/notice"
import type { ServiceStatus } from "@/lib/queries/health"

const copy = {
  down: {
    tone: "danger",
    icon: CircleAlert,
    title: "Can't reach Cadence",
    description:
      "Balances and payments won't load until it's back. Check your connection; this page checks again on its own.",
  },
  failing: {
    tone: "danger",
    icon: CircleAlert,
    title: "Cadence is having trouble",
    description:
      "Balances and payments may not load until it's fixed. This page checks again on its own.",
  },
  degraded: {
    tone: "warning",
    icon: TriangleAlert,
    title: "Cadence can't reach Solana",
    description:
      "Balances may not load and payments can't be sent until it's back. This page checks again on its own.",
  },
} as const satisfies Record<ServiceStatus, unknown>

// Above every signed-in screen while the health check reports a problem; nothing when
// the service is fine. The live region stays mounted and only its contents change: a
// region that appears already filled is often not read out. A status, not an alert,
// even when down: it comes from a poll nobody asked for, so it waits for the reader
// instead of cutting into what they are doing, and it never offers a button.
export function ServiceStatusBanner({
  status,
  className,
}: {
  status: ServiceStatus | null
  className?: string
}) {
  return (
    <div role="status" className="print:hidden">
      {status && <Notice {...copy[status]} className={className} />}
    </div>
  )
}
