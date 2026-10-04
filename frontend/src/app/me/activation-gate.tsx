"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { isActivated, doneFromStatus } from "@/lib/activation/machine"
import { messageFor } from "@/lib/api"
import { useAccountStatus } from "@/lib/queries/status"

// Sends a recipient who has not finished setting up to /activate, and shows the page
// only once the account is known to be set up, so there is no flash of a balance
// that cannot exist yet.
export function ActivationGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const status = useAccountStatus()
  const incomplete = status.data && !isActivated(doneFromStatus(status.data))

  useEffect(() => {
    if (incomplete) router.replace("/activate")
  }, [incomplete, router])

  if (status.data && !incomplete) return children
  if (status.isError && !status.data) {
    return (
      <ErrorState
        title="Couldn't check your account"
        description={messageFor(status.error)}
        onRetry={() => status.refetch()}
      />
    )
  }
  return (
    <div
      role="status"
      aria-label={incomplete ? "Taking you to setup" : "Loading your account"}
      className="space-y-4"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  )
}
