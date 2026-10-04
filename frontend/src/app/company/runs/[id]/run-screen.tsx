"use client"

import Link from "next/link"
import { SearchX } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { isApiError } from "@/lib/api/errors"
import { usePeople } from "@/lib/queries/people"
import { useRun } from "@/lib/queries/payroll"
import { runMessage } from "@/lib/runs/messages"
import { nameLookup } from "@/lib/runs/people"
import { holdsUnconfirmed } from "@/lib/runs/progress"
import { useLeaveGuard } from "@/lib/runs/use-leave-guard"
import { useRunSigner } from "@/lib/runs/use-run-signer"
import { RunProgress } from "../run-progress"

export function RunNotFound() {
  return (
    <EmptyState
      className="max-w-3xl"
      icon={SearchX}
      title="Run not found"
      description="This payroll run doesn't exist, or it belongs to another company."
      action={
        <Link href="/company" className={buttonVariants()}>
          Back to payments
        </Link>
      }
    />
  )
}

export function RunScreen({ runId }: { runId: string }) {
  const run = useRun(runId)
  const people = usePeople()
  const signer = useRunSigner()
  useLeaveGuard(signer.busy || holdsUnconfirmed(signer.local))

  const data = run.data
  if (!data && !run.isError) {
    return (
      <div aria-busy className="max-w-3xl space-y-3">
        <span className="sr-only">Loading the run</span>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    )
  }
  if (!data) {
    // A run of another company is also a 404, so the page says only that it isn't here.
    if (isApiError(run.error) && run.error.status === 404)
      return <RunNotFound />
    return (
      <ApiErrorState
        error={run.error}
        title="Couldn't load this run"
        description={runMessage(run.error)}
        onRetry={() => run.refetch()}
      />
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-ui text-ink-muted">
        Started{" "}
        <time dateTime={data.created_at}>
          {new Date(data.created_at).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </p>
      <RunProgress
        runId={runId}
        signer={signer}
        nameOf={nameLookup(people.data?.people, !people.isPending)}
      />
      <div className="flex flex-wrap gap-2">
        <Link
          href="/company"
          className={buttonVariants({ variant: "secondary" })}
        >
          Back to payments
        </Link>
        <Link href="/company/runs/new" className={buttonVariants()}>
          New payroll run
        </Link>
      </div>
    </div>
  )
}
