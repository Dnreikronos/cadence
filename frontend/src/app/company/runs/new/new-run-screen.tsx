"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownToLine, Users } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { unitsToUsd } from "@/lib/money"
import { refetchFailed } from "@/lib/queries/refetch-failed"
import { useRestoreFocus } from "@/lib/restore-focus"
import {
  useCompanyBalance,
  useCreateRun,
  usePayrollPeople,
  useRecentlyPaid,
} from "@/lib/queries/payroll"
import { useAuditors } from "@/lib/queries/auditors"
import type { ViewerScope } from "@/lib/queries/keys"
import { useSendInvite } from "@/lib/queries/people"
import { hasActiveAuditor } from "@/lib/people/view"
import { runMessage } from "@/lib/runs/messages"
import { tooManyRecent, tooManyRecentMessage } from "@/lib/runs/recent"
import type { CreatedRun } from "@/lib/runs/create"
import {
  allChoices,
  createdMatches,
  formatExact,
  holdChecking,
  isTicked,
  maxRunPayments,
  payLabel,
  peopleCount,
  repaid,
  runTotal,
  selectRecipients,
  shortfall,
  splitRoster,
  type Choices,
  type PayrollPerson,
} from "@/lib/runs/plan"
import { createLatch } from "@/lib/runs/latch"
import { holdsUnconfirmed } from "@/lib/runs/progress"
import { acquireFlowLock, otherTabMessage } from "@/lib/flow-lock"
import { releaseMessage, releaseUnreadableUnderLock } from "@/lib/release"
import { storageBlockedMessage } from "@/lib/storage-guard"
import { useStorageGate } from "@/lib/use-storage-gate"
import {
  canReleasePayment,
  releasePersonChecked,
  releaseWarning,
  runEvidenceFor,
  runBlocker,
  unreadableMessage,
} from "@/lib/runs/evidence"
import { paymentKey } from "@/lib/runs/executor"
import { useLeaveGuard } from "@/lib/runs/use-leave-guard"
import {
  runLockName,
  useRunSigner,
  useSentPayments,
  useUnreadablePayments,
  useUnsettledPeople,
} from "@/lib/runs/use-run-signer"
import { RunProgress } from "../run-progress"
import { ConfirmRunDialog } from "./confirm-dialog"
import { CheckingList, ExcludedList, PayableList } from "./roster"
import { ReleaseAction } from "@/components/app/release-action"
import { StorageNotice } from "@/components/app/storage-notice"

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
  const invite = useSendInvite()
  const auditors = useAuditors()
  const signer = useRunSigner(viewer)
  // What an earlier page left behind: the payments that may have been sent. Kept per
  // viewer in the browser's storage, shared by its tabs.
  const evidence = runEvidenceFor(viewer)
  const sentPayments = useSentPayments(viewer)
  const unsettled = useUnsettledPeople(viewer)
  const unreadable = useUnreadablePayments(viewer)
  const gate = useStorageGate()
  // Now, for offering to release a person; moves every 15 s.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  // A run being created, signed or confirmed cannot be left without losing track of it.
  useLeaveGuard(
    create.isPending || signer.busy || holdsUnconfirmed(signer.local),
  )

  const [choices, setChoices] = useState<Choices>({})
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [created, setCreated] = useState<CreatedRun | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  // Taken before the request starts: a double click is two handlers in a row, and neither
  // `create.isPending` nor state has changed yet when the second one runs.
  const [latch] = useState(createLatch)
  const [starting, setStarting] = useState(false)

  // Whoever has a payment that may have been sent and is not settled is not payable, and
  // is listed apart, until it is: paying them again could pay them twice.
  const roster = useMemo(() => {
    const { payable, excluded } = splitRoster(people.data ?? [])
    return { ...holdChecking(payable, unsettled), excluded }
  }, [people.data, unsettled])
  const recentlyPaid = recent.data ?? nobody

  const recipients = useMemo(
    () => selectRecipients(roster.payable, recentlyPaid, choices),
    [roster.payable, recentlyPaid, choices],
  )
  const total = runTotal(recipients)
  const missing = balance.data ? shortfall(total, balance.data.available) : null
  const wallet = signer.wallet

  const headingRef = useRef<HTMLHeadingElement>(null)
  // Closing the confirmation returns focus to the button that opened it; once the run is
  // created that button is gone, and the progress heading takes it.
  const restore = useRestoreFocus(() => headingRef.current)
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
          Payments to {peopleCount(created.run.payments.length)}
        </h2>
        <RunProgress
          runId={created.run.run_id}
          created={created.run}
          signer={signer}
          people={created.recipients}
        />
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/company/runs/${created.run.run_id}`}
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
      <ApiErrorState
        error={people.error}
        title="Couldn't load your people"
        describe={runMessage}
        // One "Try again" clears everything that failed: the check of who was paid in
        // the last 24 hours and the balance sit behind this list, and would otherwise
        // show their own alert once it loads.
        onRetry={() => {
          people.refetch()
          refetchFailed([recent, balance])
        }}
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
    restore.remember()
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
    // Nothing is sent that cannot be remembered, and nothing while saved state is unread.
    if (gate.blocks) {
      setCreateError(storageBlockedMessage)
      return
    }
    if (unreadable) {
      setCreateError(unreadableMessage)
      return
    }
    if (!latch.tryEnter()) return
    setStarting(true)
    const done = () => {
      latch.release()
      setStarting(false)
    }
    const recipients = review.recipients
    // One tab at a time: the run lock is held from here until the run has been signed.
    void acquireFlowLock(runLockName(viewer)).then((got) => {
      if (got.status === "busy") {
        setCreateError(otherTabMessage("run"))
        done()
        return
      }
      const lease = got.lease
      // Another tab may have sent a payment to someone in this list, or left saved state
      // this tab cannot read, while the lock was being asked for: look at what is saved
      // now, with the lock held.
      const blocker = runBlocker(evidence, recipients)
      if (blocker) {
        lease.release()
        setCreateError(blocker)
        done()
        return
      }
      setCreateError(null)
      // Creating a run moves no money: until its payments are signed below, none of them
      // can land, so a lost answer needs no record.
      create.mutate(
        { signer: wallet.signer, recipients },
        {
          onSettled: done,
          onSuccess: (made) => {
            // Sign only what was asked for: our wallet, the same accounts, once each.
            if (!createdMatches(made.request, made.run)) {
              lease.release()
              setCreateError(
                "Cadence prepared payments for different people than you chose, so nothing was signed. Check your payments before trying again.",
              )
              return
            }
            restore.originRemoved()
            setCreated(made)
            setConfirming(false)
            void signer.start(
              made.run,
              (position) => made.recipients[position]?.id ?? "",
              lease,
            )
          },
          onError: (error) => {
            lease.release()
            setCreateError(runMessage(error))
          },
        },
      )
    })
  }

  function closeDialog(open: boolean) {
    // A run being created cannot be abandoned from here: its result would be lost.
    if (open || create.isPending || starting) return
    setConfirming(false)
    setCreateError(null)
  }

  const signable = wallet.status === "ready"
  const tooMany = recipients.length > maxRunPayments
  const blocked =
    gate.blocks ||
    unreadable ||
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
      {people.truncated && (
        <p role="status" className="text-ui/normal text-warning-fg">
          More people exist than could be read, so someone may be missing from
          this run.
        </p>
      )}
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

      {signer.otherTab && (
        <p role="status" className="text-ui/normal text-warning-fg">
          {otherTabMessage("run")}
        </p>
      )}
      <StorageNotice />
      {unreadable && (
        <div
          role="alert"
          className="space-y-2 rounded-xl border border-warning-border bg-warning-bg p-4 text-ui/normal text-warning-fg"
        >
          <p className="font-medium">{unreadableMessage}</p>
          <ReleaseAction
            label="Release unreadable state"
            warning={releaseWarning}
            prompt="I checked the payments, release this saved state"
            onRelease={async () =>
              releaseMessage(
                await releaseUnreadableUnderLock(
                  () => acquireFlowLock(runLockName(viewer)),
                  () => evidence.payments.clearUnreadable(),
                ),
                "run",
              )
            }
          />
        </div>
      )}
      {roster.checking.length > 0 && (
        <CheckingList
          checking={roster.checking}
          payments={sentPayments}
          lookingUp={signer.checking}
          canRelease={(payment) =>
            canReleasePayment(payment, {
              now,
              lookedUp: !signer.checking.has(
                paymentKey(payment.run_id, payment.position),
              ),
            })
          }
          onRelease={async (personId) =>
            releaseMessage(
              await releasePersonChecked({
                evidence,
                personId,
                seen: sentPayments.filter(
                  (payment) => payment.person_id === personId,
                ),
                lock: () => acquireFlowLock(runLockName(viewer)),
              }),
              "run",
            )
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
          hasAuditor={hasActiveAuditor(auditors.data)}
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
        pending={create.isPending || starting}
        error={createError}
        onConfirm={startRun}
        finalFocus={restore.finalFocus}
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
  hasAuditor,
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
  hasAuditor: boolean | undefined
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
            <WhoCanSee viewerRole="admin" hasAuditor={hasAuditor} />
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
          {tooManyRecent(recent.error) ? (
            tooManyRecentMessage
          ) : (
            <>
              Couldn&apos;t check who was paid in the last 24 hours, so a run
              can&apos;t be started: it could pay someone twice.
            </>
          )}{" "}
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
