"use client"

import { useRef, useState } from "react"
import { PenLine, RotateCw } from "lucide-react"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useRun } from "@/lib/queries/payroll"
import type { Run } from "@/lib/api/schemas"
import { sumUnits } from "@/lib/money"
import { paymentKey } from "@/lib/runs/executor"
import { runMessage } from "@/lib/runs/messages"
import { initialsOf, peopleByAccount, unknownPerson } from "@/lib/runs/people"
import type { PayrollPerson } from "@/lib/runs/plan"
import {
  canRecheck,
  canRetry,
  canSignAgain,
  mergeRow,
  tally,
} from "@/lib/runs/progress"
import type { RunSigner } from "@/lib/runs/use-run-signer"
import { useRestoreFocus } from "@/lib/restore-focus"
import { cn } from "@/lib/utils"
import { ConfirmRunDialog } from "./new/confirm-dialog"
import { RunStatusPill } from "./run-status"

// Every payment of a run, live. For a run created in this session `created` is shown
// until the run has been read; the signer holds what this browser is doing to each one.
// The screen that owns the signer also owns the leave guard.
export function RunProgress({
  runId,
  created,
  signer,
  people,
}: {
  runId: string
  created?: Run
  signer: RunSigner
  // The payroll people, with their accounts and current amounts; undefined until read.
  people: readonly PayrollPerson[] | undefined
}) {
  const run = useRun(runId)
  const [retrying, setRetrying] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  // Closing the retry dialog returns focus to its button; once the retry starts and the
  // button is gone, to the list.
  const restore = useRestoreFocus(() => sectionRef.current)
  const data = run.data ?? created
  const personAt = peopleByAccount(people)
  // The accounts a payment signed again may go to: the people's own, as this app read
  // them. A retry narrows it to the people the admin approved in its dialog.
  const payees = new Set(
    (people ?? []).flatMap((person) =>
      person.tokenAccount ? [person.tokenAccount] : [],
    ),
  )

  if (!data) {
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

  const personOf = (position: number) => {
    const destination = data.payments.find(
      (p) => p.position === position,
    )?.destination
    return (destination && personAt(destination)?.id) ?? destination ?? ""
  }
  const rows = data.payments.map((payment) => {
    const key = paymentKey(runId, payment.position)
    return {
      payment,
      key,
      person: personAt(payment.destination),
      row: mergeRow(
        signer.local[key],
        payment,
        signer.holds(runId, payment.position),
      ),
    }
  })
  const counts = tally(rows.map(({ row }) => row))
  const canSign = signer.wallet.status === "ready" && !signer.busy
  // What a retry would pay, at today's amounts: a person no longer listed, or without an
  // amount, cannot be retried from here.
  const retryable = rows.filter(({ row }) => canRetry(row))
  const retryPeople = retryable.flatMap(({ payment, person }) =>
    person?.amount ? [{ position: payment.position, person }] : [],
  )

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label="Payments in this run"
      className="space-y-4 outline-none"
    >
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
        {rows.map(({ payment, key, person, row }) => {
          const name = people ? (person?.name ?? unknownPerson) : undefined
          const label = name ?? "this person"
          return (
            <PaymentRow
              key={key}
              name={name}
              status={
                <RunStatusPill
                  status={row.status}
                  label={
                    signer.checking.has(key) && row.status === "waiting"
                      ? "Checking"
                      : undefined
                  }
                />
              }
              message={row.message}
              danger={row.status === "failed" || row.status === "expired"}
              checking={signer.checking.has(key) && row.status === "waiting"}
            >
              {canSignAgain(row) && (
                <RowButton
                  icon={<PenLine className="size-3.5" />}
                  label={`Sign again: the payment to ${label}`}
                  disabled={!canSign}
                  onClick={() => void signer.signAgain(runId, personOf, payees)}
                >
                  Sign again
                </RowButton>
              )}
              {canRecheck(row) && payment.request_id && (
                <RowButton
                  icon={<RotateCw className="size-3.5" />}
                  label={`Check again: the payment to ${label}`}
                  disabled={!canSign}
                  onClick={() =>
                    row.signature &&
                    void signer.recheck(
                      runId,
                      {
                        position: payment.position,
                        request_id: payment.request_id ?? "",
                      },
                      row.signature,
                      personOf,
                    )
                  }
                >
                  Check again
                </RowButton>
              )}
            </PaymentRow>
          )
        })}
      </ul>

      {retryable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!canSign || retryPeople.length === 0}
            onClick={() => {
              restore.remember()
              setRetrying(true)
            }}
            className={buttonVariants({ variant: "secondary" })}
          >
            <RotateCw className="size-3.5" />
            Retry failed payments
          </button>
          {retryPeople.length < retryable.length && (
            <p className="text-caption/normal text-ink-muted">
              {retryable.length - retryPeople.length === 1
                ? "One failed payment is to someone with no amount or no longer on your list, and can't be retried from here."
                : `${retryable.length - retryPeople.length} failed payments are to people with no amount or no longer on your list, and can't be retried from here.`}
            </p>
          )}
        </div>
      )}

      {run.isError && run.data === undefined && created && (
        <p role="alert" className="text-caption text-danger-fg">
          Couldn&apos;t read this run from Cadence. Showing what was prepared.
        </p>
      )}
      {signer.wallet.status === "unavailable" && !signer.wallet.loading && (
        <p className="text-ui/normal text-ink-muted">
          Signing isn&apos;t available in this environment yet, so payments
          can&apos;t be sent or retried from here.
        </p>
      )}
      {/* A cancelled signature stopped the run: the payments after it wait on it. */}
      {(counts.open === 0 || (counts.cancelled > 0 && !signer.busy)) && (
        <Done counts={counts} />
      )}

      <ConfirmRunDialog
        open={retrying}
        onOpenChange={(open) => setRetrying(open)}
        title={`Retry ${retryPeople.length === 1 ? "1 payment" : `${retryPeople.length} payments`}`}
        recipients={retryPeople.map(({ person }) => person)}
        repaid={[]}
        total={sumUnits(retryPeople.map(({ person }) => person.amount ?? "0"))}
        pending={false}
        error={null}
        finalFocus={restore.finalFocus}
        onConfirm={() => {
          setRetrying(false)
          void signer.retry(
            data,
            new Map(
              retryPeople.map(({ position, person }) => [
                position,
                person.amount ?? "",
              ]),
            ),
            personOf,
            new Set(
              retryPeople.flatMap(({ person }) =>
                person.tokenAccount ? [person.tokenAccount] : [],
              ),
            ),
          )
        }}
      />
    </section>
  )
}

function RowButton({
  icon,
  label,
  disabled,
  onClick,
  children,
}: {
  icon: React.ReactNode
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      // The button disappears when the row starts signing: focus moves to the row so
      // keyboard and screen reader users are not dropped at the top of the page.
      onClick={(event) => {
        event.currentTarget.closest("li")?.focus()
        onClick()
      }}
      disabled={disabled}
      aria-label={label}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      {icon}
      {children}
    </button>
  )
}

function PaymentRow({
  name,
  status,
  message,
  danger,
  checking,
  children,
}: {
  name: string | undefined
  status: React.ReactNode
  message: string | null
  danger: boolean
  // Sent before a reload and being asked about again: not paid again, not settled yet.
  checking: boolean
  children: React.ReactNode
}) {
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
      <span className="flex flex-wrap items-center gap-1.5">{status}</span>
      {children}
      {checking && (
        <p className="basis-full text-caption/normal text-ink-muted">
          This payment was sent before the page was reloaded. Checking whether
          it went through; it won&apos;t be sent again.
        </p>
      )}
      {message && (
        <p
          className={cn(
            "basis-full text-caption/normal",
            danger ? "text-danger-fg" : "text-ink-muted",
          )}
        >
          {message}
        </p>
      )}
    </li>
  )
}

function Done({ counts }: { counts: ReturnType<typeof tally> }) {
  if (counts.sent > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.sent === 1
          ? "One payment was sent but isn't confirmed."
          : `${counts.sent} payments were sent but aren't confirmed.`}{" "}
        Don&apos;t pay those people another way until they are.
      </p>
    )
  }
  if (counts.unrecognized > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.unrecognized === 1
          ? "One payment has a status this app doesn't know."
          : `${counts.unrecognized} payments have a status this app doesn't know.`}{" "}
        Check the company payments before paying those people another way.
      </p>
    )
  }
  if (counts.cancelled > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        The run stopped at a signature you cancelled, and nothing after it was
        sent. Sign again above to continue while this page is open.
      </p>
    )
  }
  if (counts.retryable > 0 || counts.notSent > 0) {
    return (
      <p className="text-ui/normal text-ink-muted">
        {counts.retryable > 0 &&
          (counts.retryable === 1
            ? "One payment didn't go through, and the run stopped there. "
            : `${counts.retryable} payments didn't go through. `)}
        {counts.retryable > 0 &&
          "Retry them above: Cadence prepares them again. "}
        {counts.notSent > 0 &&
          (counts.notSent === 1
            ? "One payment was not sent, so that person wasn't paid in this run: pay them in a new run."
            : `${counts.notSent} payments were not sent, so those people weren't paid in this run: pay them in a new run.`)}
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
