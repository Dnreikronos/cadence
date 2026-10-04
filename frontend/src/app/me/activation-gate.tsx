"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useViewerScope } from "@/components/app/viewer-scope"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { statusMessage } from "@/lib/activation/errors"
import { gateView } from "@/lib/activation/gate"
import { useAccountStatus } from "@/lib/queries/status"

// Sends a recipient who has not finished setting up to /activate, and shows the page
// only once the account is known to be set up, so there is no flash of a balance
// that cannot exist yet. See `gateView` for what a failed read does.
export function ActivationGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const status = useAccountStatus(useViewerScope())
  const view = gateView(status)

  useEffect(() => {
    if (view === "redirect") router.replace("/activate")
  }, [view, router])

  if (view === "ready") return children
  if (view === "error") {
    return (
      <ApiErrorState
        error={status.error}
        title="Couldn't check your account"
        description={statusMessage(status.error)}
        onRetry={() => status.refetch()}
      />
    )
  }
  return (
    <div
      role="status"
      aria-label={
        view === "redirect" ? "Taking you to setup" : "Loading your account"
      }
      className="space-y-4"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  )
}
