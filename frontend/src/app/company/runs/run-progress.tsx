"use client"

import { PenLine, RotateCw } from "lucide-react"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { useRun } from "@/lib/queries/payroll"
import type { RunCreated } from "@/lib/api/schemas"
import { cancelledGoneMessage, runMessage } from "@/lib/runs/messages"
import { initialsOf } from "@/lib/runs/people"
import {
  canRecheck,
  canRetry,
  canSignAgain,
  mergeRow,
  tally,
  type Row,
  type ServerRow,
} from "@/lib/runs/progress"
import type { RunSigner } from "@/lib/runs/use-run-signer"
import { cn } from "@/lib/utils"
import { RunStatusPill } from "./run-status"

type Entry = {
  paymentId: string
  personId: string
  server?: ServerRow
  // Known only once the run has been read: the service decides how a payment went out.
  transparent: boolean | null
}

// Every payment of a run, live. For a run created in this session `created` lists the
// payments to show before the first read of the run; the signer holds what this browser
// is doing to each one. The screen that owns the signer also owns the leave guard.
export function RunProgress({
  runId,
  created,
  signer,
  nameOf,
}: {
  runId: string
  created?: RunCreated
  signer: RunSigner
  // Undefined until the people list has answered.
  nameOf: (personId: string) => string | undefined
}) {
  const run = useRun(runId)

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
        transparent: null,
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
  const anyTransparent = entries.some((entry) => entry.transparent === true)

  return (
    <section aria-label="Payments in this run" className="space-y-4">
      <p role="status" className="text-ui text-ink-muted">
        <span className="font-medium text-ink">
          {counts.confirmed} of {counts.total}
        </span>{" "}
        confirmed
        {counts.attention > 0 && (
          <>
            <span aria-hidden> · </span>
            <span className="text-danger-fg">
              {counts.attention} need attention
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
            transparent={entry.transparent === true}
            canSign={canSign}
            held={signer.canSignAgain(entry.paymentId)}
            onSignAgain={() => void signer.signAgain(runId, entry.paymentId)}
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
        <p className="text-ui/normal text-ink-muted">
          Signing isn&apos;t available in this environment yet, so payments
          can&apos;t be sent or retried from here.
        </p>
      )}
      {!signer.busy && rows.some(({ row }) => row.status === "pending") && (
        <p className="text-ui/normal text-ink-muted">
          Payments still pending were not signed in this session, and a payment
          can only be signed in the session that created its run. Start a new
          run for them, and don&apos;t include people shown as Confirmed.
        </p>
      )}
      {counts.open === 0 && (
        <Done
          counts={counts}
          allRead={run.data !== undefined}
          anyTransparent={anyTransparent}
        />
      )}
    </section>
  )
}

function PaymentRow({
  name,
  row,
  transparent,
  canSign,
  held,
  onSignAgain,
  onRetry,
  onRecheck,
}: {
  name: string | undefined
  row: Row
  transparent: boolean
  canSign: boolean
  // This page still holds the transaction of a cancelled signature.
  held: boolean
  onSignAgain: () => void
  onRetry: () => void
  onRecheck: () => void
}) {
  const label = name ?? "this person"
  // The button that was clicked disappears when the row starts signing: focus moves to
  // the row so keyboard and screen reader users are not dropped at the top of the page.
  const act = (action: () => void) => (event: React.MouseEvent) => {
    event.currentTarget.closest("li")?.focus()
    action()
  }
  // A cancelled signature whose transaction this page no longer holds cannot be signed
  // again: say plainly that this person was not paid.
  const message =
    canSignAgain(row) && !held ? cancelledGoneMessage : row.message
  return (
    <li
      tabIndex={-1}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 outline-none last:border-0 focus-visible:bg-surface-subtle"
    >
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <span aria-hidden>
          <AvatarPerson initials={name ? initialsOf(name) : "…"} size={30} />
        </span>
        {name ? (
          <span className="min-w-0 text-ui font-medium wrap-break-word text-ink">
            {name}
          </span>
        ) : (
          <>
            <Skeleton className="h-3 w-28" />
            <span className="sr-only">Loading name</span>
          </>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <RunStatusPill status={row.status} />
        {transparent && <TransparentBadge />}
      </span>
      {canSignAgain(row) && held && (
        <button
          type="button"
          onClick={act(onSignAgain)}
          disabled={!canSign}
          aria-label={`Sign again: the payment to ${label}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <PenLine className="size-3.5" />
          Sign again
        </button>
      )}
      {canRetry(row) && (
        <button
          type="button"
          onClick={act(onRetry)}
          disabled={!canSign}
          aria-label={`Retry the payment to ${label}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <RotateCw className="size-3.5" />
          Retry
        </button>
      )}
      {canRecheck(row) && (
        <button
          type="button"
          onClick={act(onRecheck)}
          disabled={!canSign}
          aria-label={`Check again: the payment to ${label}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <RotateCw className="size-3.5" />
          Check again
        </button>
      )}
      {message && (
        <p
          className={cn(
            "basis-full text-caption/normal",
            row.status === "failed" || row.status === "expired"
              ? "text-danger-fg"
              : "text-ink-muted",
          )}
        >
          {message}
        </p>
      )}
    </li>
  )
}

function Done({
  counts,
  allRead,
  anyTransparent,
}: {
  counts: ReturnType<typeof tally>
  // The run has been read from the service, so its transparent flags are known.
  allRead: boolean
  anyTransparent: boolean
}) {
  if (counts.sent > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.sent === 1
          ? "One payment was sent but isn't confirmed."
          : `${counts.sent} payments were sent but aren't confirmed.`}{" "}
        Don&apos;t pay those people another way until they are.
        {counts.retryable > 0 &&
          " The others that didn't go through can be retried above."}
      </p>
    )
  }
  if (counts.cancelled > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.cancelled === 1
          ? "One payment wasn't signed, so nothing was sent for it."
          : `${counts.cancelled} payments weren't signed, so nothing was sent for them.`}{" "}
        Sign them again above while this page is open.
        {counts.retryable > 0 &&
          " The others that didn't go through can be retried."}
      </p>
    )
  }
  if (counts.retryable > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.retryable === 1
          ? "One payment didn't go through."
          : `${counts.retryable} payments didn't go through.`}{" "}
        The others are unaffected. Retry each one above.
      </p>
    )
  }
  if (!allRead) {
    return (
      <p className="text-ui/normal text-ink-muted">
        Every payment is confirmed.
      </p>
    )
  }
  return (
    <p className="text-ui/normal text-ink-muted">
      Every payment is confirmed.{" "}
      {anyTransparent
        ? "Some were sent as ordinary transfers, marked Transparent: those amounts are public on-chain. The rest are encrypted; you, the recipient, any auditor you invited and Cadence can read them."
        : "Each amount is encrypted on-chain; you, the recipient, any auditor you invited and Cadence can read it."}
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
