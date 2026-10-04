"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownToLine, Users } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import type { RunCreated } from "@/lib/api/schemas"
import { randomUuid } from "@/lib/api/uuid"
import { unitsToUsd } from "@/lib/money"
import {
  useCompanyBalance,
  useCreateRun,
  useInviteRecipient,
  usePayrollPeople,
  useRecentlyPaid,
} from "@/lib/queries/payroll"
import type { ViewerScope } from "@/lib/queries/keys"
import { runMessage } from "@/lib/runs/messages"
import { nameLookup } from "@/lib/runs/people"
import {
  allChoices,
  attemptKey,
  buildRunRequest,
  createdMatches,
  fingerprintOf,
  formatExact,
  isTicked,
  maxRunPayments,
  payLabel,
  peopleCount,
  repaid,
  runTotal,
  selectRecipients,
  shortfall,
  splitRoster,
  type AttemptKey,
  type Choices,
  type PayrollPerson,
} from "@/lib/runs/plan"
import { holdsUnconfirmed } from "@/lib/runs/progress"
import { useLeaveGuard } from "@/lib/runs/use-leave-guard"
import { useRunSigner } from "@/lib/runs/use-run-signer"
import { RunProgress } from "../run-progress"
import { ConfirmRunDialog } from "./confirm-dialog"
import { ExcludedList, PayableList } from "./roster"

// What the confirmation shows and what is sent: fixed when the dialog opens, so a list
// that refreshes underneath it cannot change who is paid.
type Review = {
  recipients: readonly PayrollPerson[]
  total: string
  repaid: readonly PayrollPerson[]
}

const nobody: ReadonlySet<string> = new Set()

export function NewRunScreen({ viewer }: { viewer: ViewerScope }) {
  const people = usePayrollPeople()
  const balance = useCompanyBalance(viewer)
  const recent = useRecentlyPaid()
  const create = useCreateRun()
  const invite = useInviteRecipient()
  const signer = useRunSigner()
  // A run being created, signed or confirmed cannot be left without losing track of it.
  useLeaveGuard(
    create.isPending || signer.busy || holdsUnconfirmed(signer.local),
  )

  const [choices, setChoices] = useState<Choices>({})
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [created, setCreated] = useState<RunCreated | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  // One idempotency key per attempt, kept across clicks and retries of the same list.
  const attempt = useRef<AttemptKey | null>(null)

  const roster = useMemo(() => splitRoster(people.data ?? []), [people.data])
  const recentlyPaid = recent.data ?? nobody
  const recipients = useMemo(
    () => selectRecipients(roster.payable, recentlyPaid, choices),
    [roster.payable, recentlyPaid, choices],
  )
  const total = runTotal(recipients)
  const missing = balance.data ? shortfall(total, balance.data.available) : null
  const wallet = signer.wallet

  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    // The roster the button lived in is gone: bring focus to the progress.
    if (created) headingRef.current?.focus()
  }, [created])

  if (created) {
    return (
      <div className="max-w-3xl space-y-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lead font-medium text-ink outline-none"
        >
          Payments to {peopleCount(created.payments.length)}
        </h2>
        <RunProgress
          runId={created.run_id}
          created={created}
          signer={signer}
          nameOf={nameLookup(people.data, !people.isPending)}
        />
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/company/runs/${created.run_id}`}
            className={buttonVariants({ variant: "secondary" })}
          >
            Open this run
          </Link>
          <Link
            href="/company"
            className={buttonVariants({ variant: "secondary" })}
          >
            Back to payments
          </Link>
          <button
            type="button"
            disabled={signer.busy}
            onClick={() => {
              attempt.current = null
              create.reset()
              setCreated(null)
              setChoices({})
            }}
            className={buttonVariants()}
          >
            Start another run
          </button>
        </div>
      </div>
    )
  }

  if (!people.data) {
    if (!people.isError) return <RosterSkeleton />
    return (
      <ErrorState
        title="Couldn't load your people"
        description={runMessage(people.error)}
        onRetry={() => people.refetch()}
      />
    )
  }

  if (people.data.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No one to pay yet"
        description="Add the people you pay, and invite them to set up a private account."
        action={
          <Link href="/company/people" className={buttonVariants()}>
            Go to people
          </Link>
        }
      />
    )
  }

  function toggle(id: string) {
    setChoices((current) => ({
      ...current,
      [id]: !isTicked(id, recentlyPaid, current),
    }))
  }

  function openReview() {
    setReview({
      recipients,
      total,
      repaid: repaid(recipients, recentlyPaid),
    })
    setCreateError(null)
    setConfirming(true)
  }

  function startRun() {
    if (!wallet.address || !review) return
    const key = attemptKey(
      attempt.current,
      fingerprintOf(wallet.address, review.recipients),
      randomUuid,
    )
    attempt.current = key
    let request
    try {
      request = buildRunRequest(wallet.address, review.recipients, key.key)
    } catch {
      setCreateError("This run isn't valid. Check who is ticked and try again.")
      return
    }
    setCreateError(null)
    create.mutate(request, {
      onSuccess: (run) => {
        // Sign only what was asked for: the same people, once each.
        if (!createdMatches(request, run)) {
          setCreateError(
            "Cadence prepared payments for different people than you chose, so nothing was signed. Check your payments before trying again.",
          )
          return
        }
        setCreated(run)
        setConfirming(false)
        void signer.start(run)
      },
      onError: (error) => setCreateError(runMessage(error)),
    })
  }

  function closeDialog(open: boolean) {
    // A run being created cannot be abandoned from here: its result would be lost.
    if (open || create.isPending) return
    setConfirming(false)
    setCreateError(null)
  }

  const signable = wallet.status === "ready"
  const tooMany = recipients.length > maxRunPayments
  const blocked =
    recipients.length === 0 ||
    tooMany ||
    missing !== null ||
    // Neither the balance nor who was paid today can be guessed: wait for both.
    !balance.data ||
    !recent.data ||
    !signable ||
    people.isFetching

  return (
    <div className="max-w-3xl space-y-4">
      {roster.payable.length > 0 ? (
        <PayableList
          payable={roster.payable}
          recentlyPaid={recentlyPaid}
          choices={choices}
          disabled={create.isPending}
          onToggle={toggle}
          onToggleAll={(selectAll) =>
            setChoices(allChoices(roster.payable, recentlyPaid, selectAll))
          }
        />
      ) : (
        <EmptyState
          icon={Users}
          title="No one is ready to be paid"
          description="A person can be paid once they have accepted their invite and have a monthly amount."
        />
      )}

      {roster.excluded.length > 0 && (
        <ExcludedList
          excluded={roster.excluded}
          invited={invited}
          inviting={invite.isPending}
          onInvite={(person) =>
            invite.mutate(person, {
              onSuccess: () =>
                setInvited((current) => new Set(current).add(person.id)),
            })
          }
        />
      )}

      {roster.payable.length > 0 && (
        <Summary
          count={recipients.length}
          total={total}
          balance={balance}
          missing={missing}
          tooMany={tooMany}
          wallet={wallet}
          recent={recent}
          blocked={blocked}
          onReview={openReview}
        />
      )}

      <ConfirmRunDialog
        open={confirming}
        onOpenChange={closeDialog}
        recipients={review?.recipients ?? []}
        repaid={review?.repaid ?? []}
        total={review?.total ?? "0"}
        pending={create.isPending}
        error={createError}
        onConfirm={startRun}
      />
    </div>
  )
}

function Summary({
  count,
  total,
  balance,
  missing,
  tooMany,
  wallet,
  recent,
  blocked,
  onReview,
}: {
  count: number
  total: string
  balance: ReturnType<typeof useCompanyBalance>
  missing: string | null
  tooMany: boolean
  wallet: ReturnType<typeof useRunSigner>["wallet"]
  recent: ReturnType<typeof useRecentlyPaid>
  blocked: boolean
  onReview: () => void
}) {
  return (
    <section
      aria-label="Run summary"
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <dl className="grid gap-x-6 gap-y-2 text-ui sm:grid-cols-2">
        <div>
          <dt className="text-label text-ink-muted uppercase">This run</dt>
          <dd className="mt-1 flex items-center gap-1.5">
            <AmountDisplay amount={unitsToUsd(total)} className="text-amount" />
            <WhoCanSee viewerRole="admin" hasAuditor={false} />
          </dd>
          <dd className="text-caption text-ink-muted">
            {peopleCount(count)} selected
          </dd>
        </div>
        <div>
          <dt className="text-label text-ink-muted uppercase">
            Private balance
          </dt>
          <dd className="mt-1">
            {balance.isError ? (
              <span role="alert" className="text-danger-fg">
                Couldn&apos;t read it.{" "}
                <button
                  type="button"
                  onClick={() => balance.refetch()}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </span>
            ) : (
              <AmountDisplay
                amount={
                  balance.data ? unitsToUsd(balance.data.available) : undefined
                }
                state={balance.data ? "revealed" : "loading"}
                className="text-lead"
              />
            )}
          </dd>
        </div>
      </dl>

      {missing !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-bg p-3 text-ui/normal text-warning-fg"
        >
          <p className="min-w-0 flex-1 basis-56">
            Your private balance is {formatExact(missing)} short for this run.
            Deposits are public on-chain; payments from the private balance are
            not.
          </p>
          <Link
            href="/company/deposit"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <ArrowDownToLine className="size-3.5" />
            Deposit {formatExact(missing)}
          </Link>
        </div>
      )}
      {recent.isError ? (
        <p role="alert" className="text-ui/normal text-danger-fg">
          Couldn&apos;t check who was paid in the last 24 hours, so a run
          can&apos;t be started: it could pay someone twice.{" "}
          <button
            type="button"
            onClick={() => recent.refetch()}
            className="underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : (
        !recent.data && (
          <p className="text-ui/normal text-ink-muted">
            Checking who was paid in the last 24 hours…
          </p>
        )
      )}
      {tooMany && (
        <p role="alert" className="text-ui/normal text-danger-fg">
          A run pays up to {maxRunPayments} people at once. Untick some, and pay
          them in another run.
        </p>
      )}
      {wallet.status === "unavailable" && !wallet.loading && (
        <p className="text-ui/normal text-ink-muted">
          Signing isn&apos;t available in this environment yet, so a run
          can&apos;t be started.
        </p>
      )}

      <button
        type="button"
        disabled={blocked}
        onClick={onReview}
        className={buttonVariants({
          size: "lg",
          className: "w-full sm:w-auto",
        })}
      >
        {count === 0 ? "Pick who to pay" : payLabel(count, total)}
      </button>
    </section>
  )
}

function RosterSkeleton() {
  return (
    <div
      aria-busy
      className="max-w-3xl overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading your people</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-0"
        >
          <Skeleton className="size-4" />
          <Skeleton className="size-7.5 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      ))}
    </div>
  )
}
