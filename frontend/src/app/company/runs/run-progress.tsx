"use client"

import { RotateCw } from "lucide-react"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { useRun } from "@/lib/queries/payroll"
import type { RunCreated } from "@/lib/api/schemas"
import { runMessage } from "@/lib/runs/messages"
import { initialsOf } from "@/lib/runs/people"
import {
  canRetry,
  mergeRow,
  tally,
  type Row,
  type ServerRow,
} from "@/lib/runs/progress"
import { useLeaveGuard } from "@/lib/runs/use-leave-guard"
import type { RunSigner } from "@/lib/runs/use-run-signer"
import { cn } from "@/lib/utils"
import { RunStatusPill } from "./run-status"

type Entry = {
  paymentId: string
  personId: string
  server?: ServerRow
  transparent: boolean
}

// Every payment of a run, live. For a run created in this session `created` lists the
// payments to show before the first read of the run; the signer holds what this browser
// is doing to each one.
export function RunProgress({
  runId,
  created,
  signer,
  nameOf,
}: {
  runId: string
  created?: RunCreated
  signer: RunSigner
  nameOf: (personId: string) => string
}) {
  const run = useRun(runId)
  useLeaveGuard(signer.busy)

  const entries: Entry[] | undefined = run.data
    ? run.data.payments.map((payment) => ({
        paymentId: payment.payment_id,
        personId: payment.person_id,
        server: { status: payment.status, failure: payment.failure },
        transparent: payment.transparent,
      }))
    : created?.payments.map((payment) => ({
        paymentId: payment.payment_id,
        personId: payment.person_id,
        transparent: false,
      }))

  if (!entries) {
    if (run.isError) {
      return (
        <ErrorState
          title="Couldn't load this run"
          description={runMessage(run.error)}
          onRetry={() => run.refetch()}
        />
      )
    }
    return <ProgressSkeleton />
  }

  const rows = entries.map((entry) => ({
    entry,
    row: mergeRow(signer.local[entry.paymentId], entry.server),
  }))
  const counts = tally(rows.map(({ row }) => row))
  const canSign = signer.wallet.status === "ready" && !signer.busy

  return (
    <section aria-label="Payments in this run" className="space-y-4">
      <p role="status" className="text-ui text-ink-muted">
        <span className="font-medium text-ink">
          {counts.confirmed} of {counts.total}
        </span>{" "}
        confirmed
        {counts.failed > 0 && (
          <>
            <span aria-hidden> · </span>
            <span className="text-danger-fg">
              {counts.failed} need attention
            </span>
          </>
        )}
      </p>

      <ul className="overflow-hidden rounded-xl border border-line bg-surface">
        {rows.map(({ entry, row }) => (
          <PaymentRow
            key={entry.paymentId}
            name={nameOf(entry.personId)}
            row={row}
            transparent={entry.transparent}
            canSign={canSign}
            onRetry={() => void signer.retry(runId, entry.paymentId)}
            onRecheck={() =>
              row.signature &&
              void signer.recheck(runId, entry.paymentId, row.signature)
            }
          />
        ))}
      </ul>

      {run.isError && (
        <p role="alert" className="text-caption text-danger-fg">
          Couldn&apos;t refresh the status. Trying again.
        </p>
      )}
      {signer.wallet.status === "unavailable" && !signer.wallet.loading && (
        <p className="text-caption text-ink-muted">
          Signing isn&apos;t available in this environment yet, so payments
          can&apos;t be sent or retried from here.
        </p>
      )}
      {!signer.busy && rows.some(({ row }) => row.status === "pending") && (
        <p className="text-ui/normal text-ink-muted">
          Payments still pending were not signed in this session. A payment can
          only be signed in the session that created its run, so pay them in a
          new run.
        </p>
      )}
      {counts.open === 0 && <Done failed={counts.failed} />}
    </section>
  )
}

function PaymentRow({
  name,
  row,
  transparent,
  canSign,
  onRetry,
  onRecheck,
}: {
  name: string
  row: Row
  transparent: boolean
  canSign: boolean
  onRetry: () => void
  onRecheck: () => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:border-0">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <span aria-hidden>
          <AvatarPerson initials={initialsOf(name)} size={30} />
        </span>
        <span className="min-w-0 text-ui font-medium wrap-break-word text-ink">
          {name}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <RunStatusPill status={row.status} />
        {transparent && <TransparentBadge />}
      </span>
      {canRetry(row) && (
        <button
          type="button"
          onClick={onRetry}
          disabled={!canSign}
          aria-label={`Retry the payment to ${name}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <RotateCw className="size-3.5" />
          Retry
        </button>
      )}
      {row.stalled && row.signature && (
        <button
          type="button"
          onClick={onRecheck}
          disabled={!canSign}
          aria-label={`Check the payment to ${name} again`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <RotateCw className="size-3.5" />
          Check again
        </button>
      )}
      {row.message && (
        <p
          role={row.stalled ? "status" : "alert"}
          className={cn(
            "basis-full text-caption/normal",
            row.stalled ? "text-ink-muted" : "text-danger-fg",
          )}
        >
          {row.message}
        </p>
      )}
    </li>
  )
}

function Done({ failed }: { failed: number }) {
  if (failed > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {failed === 1
          ? "One payment didn't go through."
          : `${failed} payments didn't go through.`}{" "}
        The others are unaffected. Retry each one above.
      </p>
    )
  }
  return (
    <p className="text-ui/normal text-ink-muted">
      Every payment is confirmed. Each amount is encrypted on-chain; you, the
      recipient, any auditor you invited and Cadence can read it.
    </p>
  )
}

function ProgressSkeleton() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading payments</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="size-7.5 rounded-full" />
          <Skeleton className="h-3 w-40" />
        </div>
      ))}
    </div>
  )
}
