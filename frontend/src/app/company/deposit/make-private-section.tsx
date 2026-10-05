"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Check, CircleAlert, Eye, Loader2, RotateCw } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { describeUsdc } from "@/lib/deposit/controller"
import { confirmedMessage, doneMessage } from "@/lib/deposit/message"
import { formatBaseUnits, toBaseUnits } from "@/lib/deposit/schema"
import { makePrivateSteps, stepLabels } from "@/lib/deposit/types"
import { hasActiveAuditor } from "@/lib/people/view"
import { unitsToUsd } from "@/lib/money"
import { useAuditors } from "@/lib/queries/auditors"
import {
  useCompanyBalance,
  useMakePrivate,
  usePublicUsdc,
  type MakePrivateState,
} from "@/lib/queries/deposit"
import { cn } from "@/lib/utils"
import { StepHeading } from "./receive-section"

export function MakePrivateSection({ wallet }: { wallet: string }) {
  const id = useId()
  const flow = useMakePrivate(wallet)
  const publicUsdc = usePublicUsdc(wallet)
  const privateBalance = useCompanyBalance(wallet)
  const auditors = useAuditors()
  // Unknown (loading or failed) reads as the longer sentence, never "no auditor".
  const hasAuditor = hasActiveAuditor(auditors.data)
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string>()
  const sectionRef = useRef<HTMLElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const { state } = flow

  // Clear the field once a deposit goes through (not when only a pending credit
  // was applied: that leaves what the person typed alone), during render rather
  // than in an effect.
  const [seen, setSeen] = useState(state.status)
  if (seen !== state.status) {
    setSeen(state.status)
    if (state.status === "done" && state.amount !== undefined) setAmount("")
    // The deposit already went out (or may have): typing it again would repeat it.
    if (state.status === "failed" && state.resume !== "wrap") setAmount("")
  }

  // The buttons that start and end a flow remove themselves, so focus is sent on.
  const previous = useRef(state.status)
  useEffect(() => {
    const was = previous.current
    previous.current = state.status
    if (was === state.status) return
    if (state.status === "failed") {
      alertRef.current?.focus()
    } else if (state.status === "running" || state.status === "checking") {
      if (!sectionRef.current?.contains(document.activeElement)) {
        statusRef.current?.focus()
      }
    } else if (state.status === "resolved") {
      statusRef.current?.focus()
    } else if (state.status === "idle") {
      amountRef.current?.focus()
    }
  }, [state.status])

  const isBusy = state.status === "running" || state.status === "checking"
  // A failed attempt is resolved with Try again or Dismiss, not by starting another.
  const locked = isBusy || state.status === "failed"
  const publicUnits = publicUsdc.data ? BigInt(publicUsdc.data) : undefined
  const hasFunds = publicUnits !== undefined && publicUnits > 0n
  const pending = privateBalance.data ? BigInt(privateBalance.data.pending) : 0n

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (locked || publicUnits === undefined) return
    const parsed = toBaseUnits(amount, publicUnits)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }
    setError(undefined)
    void flow.deposit(parsed.units.toString())
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby="private-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <StepHeading n={2} id="private-heading">
        Make it private
      </StepHeading>

      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        <Balance
          label="Public USDC"
          hint="Visible to anyone on-chain"
          units={publicUsdc.data}
          isPending={publicUsdc.isPending}
          isError={publicUsdc.isError}
          errorText="Couldn't read the network."
          staleText="Couldn't refresh. Max may be out of date."
          onRetry={() => publicUsdc.refetch()}
        />
        <Balance
          label="Private USDC"
          hint={
            pending > 0n
              ? `${describeUsdc(pending.toString())} still becoming available`
              : "Available to pay people"
          }
          units={privateBalance.data?.available}
          isPending={privateBalance.isPending}
          isError={privateBalance.isError}
          errorText="Couldn't load this balance."
          staleText="Couldn't refresh. This may be out of date."
          onRetry={() => privateBalance.refetch()}
          adornment={
            <WhoCanSee
              viewerRole="admin"
              hasAuditor={hasAuditor}
              scope="balance"
            />
          }
        />
      </dl>

      {pending > 0n && !locked && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-line bg-surface-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-ui/normal text-ink-muted">
            {describeUsdc(pending.toString())} from an earlier deposit is
            waiting to become available. You can&apos;t pay with it until then.
          </p>
          <button
            type="button"
            onClick={() => void flow.applyPending()}
            className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
          >
            Make available
          </button>
        </div>
      )}

      <p
        id={`${id}-public`}
        className="mt-5 flex gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-ui/normal text-warning-fg"
      >
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          This step is public. The amount you move to private USDC is visible
          on-chain. What you pay out afterwards is encrypted on-chain; Cadence
          and your auditors can read it.
        </span>
      </p>

      <form onSubmit={submit} noValidate className="mt-5 space-y-3">
        <label htmlFor={`${id}-amount`} className="text-ui font-medium">
          Amount to make private (USDC)
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              ref={amountRef}
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              disabled={!hasFunds}
              readOnly={locked}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value)
                setError(undefined)
              }}
              aria-invalid={!!error}
              aria-describedby={
                [error ? `${id}-error` : "", `${id}-public`]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              className={cn(
                fieldClass,
                "h-10 pr-14 font-mono tabular-nums read-only:bg-surface-subtle read-only:text-ink-muted disabled:opacity-50",
              )}
            />
            <button
              type="button"
              disabled={!hasFunds}
              aria-disabled={locked || undefined}
              onClick={() => {
                if (locked || publicUnits === undefined) return
                setAmount(formatBaseUnits(publicUnits))
                setError(undefined)
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md px-2 py-1 text-caption font-medium text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-50 aria-disabled:opacity-50"
            >
              Max
            </button>
          </div>
          <button
            type="submit"
            disabled={!hasFunds}
            aria-disabled={locked || undefined}
            aria-describedby={`${id}-public`}
            className={cn(
              buttonVariants({ size: "lg" }),
              "aria-disabled:opacity-50",
            )}
          >
            {isBusy && (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {isBusy ? "Working…" : "Make private"}
          </button>
        </div>
        {error && (
          <p
            id={`${id}-error`}
            role="alert"
            className="text-caption text-danger-fg"
          >
            {error}
          </p>
        )}
        {publicUnits === 0n && (
          <p className="text-caption/normal text-ink-muted">
            You hold no public USDC yet. Send some to the address above first.
          </p>
        )}
        {publicUnits === undefined && !publicUsdc.isPending && (
          <p className="text-caption/normal text-ink-muted">
            Your public balance has to load before you can move any of it.
          </p>
        )}
      </form>

      {/* Announced politely and once: a failure is the alert below, not this. */}
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="outline-none"
      >
        {state.status === "running" && (
          <Progress step={state.step} className="mt-4" />
        )}
        {state.status === "checking" && <Checking />}
        {state.status === "done" && <Done state={state} />}
        {state.status === "resolved" && (
          <Resolved state={state} onDismiss={flow.dismiss} />
        )}
      </div>

      {state.status === "failed" && (
        <>
          <Progress step={state.step} failed className="mt-4" />
          <Failure ref={alertRef} flow={flow} state={state} />
        </>
      )}
    </section>
  )
}

function Balance({
  label,
  hint,
  units,
  isPending,
  isError,
  errorText,
  staleText,
  onRetry,
  adornment,
}: {
  label: string
  hint: string
  // Base units, once loaded.
  units: string | undefined
  isPending: boolean
  isError: boolean
  errorText: string
  // Shown when a refresh failed but an earlier answer is still on screen.
  staleText: string
  onRetry: () => void
  adornment?: React.ReactNode
}) {
  const retry = (
    <button
      type="button"
      onClick={onRetry}
      className="font-medium underline underline-offset-2"
    >
      Try again
    </button>
  )
  return (
    <div className="bg-surface-subtle p-4">
      <dt className="flex items-center justify-between text-label text-ink-muted uppercase">
        {label}
        {adornment}
      </dt>
      <dd className="mt-1.5">
        {units !== undefined ? (
          <AmountDisplay amount={unitsToUsd(units)} className="text-amount" />
        ) : isPending ? (
          <span aria-busy>
            <Skeleton className="h-7 w-32" />
            <span className="sr-only">Loading {label}</span>
          </span>
        ) : (
          <span className="font-mono text-amount text-ink-muted">
            Unavailable
          </span>
        )}
        {isError && units === undefined && (
          <p role="alert" className="mt-1 text-caption text-danger-fg">
            {errorText} {retry}
          </p>
        )}
        {isError && units !== undefined && (
          <p role="status" className="mt-1 text-caption text-warning-fg">
            {staleText} {retry}
          </p>
        )}
        {!isError && <p className="mt-1 text-caption text-ink-muted">{hint}</p>}
      </dd>
    </div>
  )
}

function Progress({
  step,
  failed = false,
  className,
}: {
  step: (typeof makePrivateSteps)[number]
  failed?: boolean
  className?: string
}) {
  const current = makePrivateSteps.indexOf(step)
  return (
    <ol className={cn("space-y-1.5", className)}>
      {makePrivateSteps.map((name, index) => {
        const state =
          index < current
            ? "done"
            : index === current
              ? failed
                ? "failed"
                : "active"
              : "todo"
        return (
          <li
            key={name}
            aria-current={state === "active" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 text-ui",
              state === "todo" ? "text-ink-muted" : "text-ink",
            )}
          >
            <span className="grid size-4 place-items-center">
              {state === "done" && (
                <Check className="size-3.5 text-success-dot" />
              )}
              {state === "active" && (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {state === "failed" && (
                <CircleAlert className="size-3.5 text-danger-fg" />
              )}
              {state === "todo" && (
                <span className="size-1.5 rounded-full bg-line" />
              )}
            </span>
            {stepLabels[name]}
            {state === "done" && <span className="sr-only"> (done)</span>}
            {state === "failed" && <span className="sr-only"> (failed)</span>}
          </li>
        )
      })}
    </ol>
  )
}

function Checking() {
  return (
    <p className="mt-4 flex items-start gap-2 text-ui/normal text-ink">
      <Loader2
        aria-hidden
        className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span>
        Checking your last deposit. It was sent a moment ago, and a new one
        waits until we know what became of it. This can take a minute or two.
      </span>
    </p>
  )
}

function Done({
  state,
}: {
  state: Extract<MakePrivateState, { status: "done" }>
}) {
  return (
    <p className="mt-4 flex items-start gap-2 text-ui/normal text-ink">
      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success-dot" />
      {doneMessage(state)}
    </p>
  )
}

const resolvedText = {
  confirmed:
    "Your last deposit went through. If it is still pending, make it available above.",
  failed: "Your last deposit didn't go through, and nothing left your wallet.",
  unknown:
    "We couldn't tell whether your last deposit went through. Check both balances above before you deposit again.",
} as const

function Resolved({
  state,
  onDismiss,
}: {
  state: Extract<MakePrivateState, { status: "resolved" }>
  onDismiss: () => void
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-ui/normal text-ink">
      <p className="min-w-0">
        {state.outcome === "confirmed"
          ? confirmedMessage(state.earlierPending)
          : resolvedText[state.outcome]}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Dismiss
      </button>
    </div>
  )
}

function Failure({
  ref,
  flow,
  state,
}: {
  ref: React.Ref<HTMLDivElement>
  flow: ReturnType<typeof useMakePrivate>
  state: Extract<MakePrivateState, { status: "failed" }>
}) {
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mt-4 flex gap-3 rounded-lg border border-danger-border bg-danger-bg p-3 text-danger-fg outline-none"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-2 text-ui/normal">
        {state.setupRequired ? (
          <>
            <p className="font-medium">Your wallet needs activating first</p>
            <p>
              Before it can hold private USDC, a company wallet has to be
              activated once. That step isn&apos;t available from this screen
              yet, and nothing was deposited.
            </p>
          </>
        ) : (
          <p>{state.message}</p>
        )}
        {state.step === "applying" && state.resume !== "wrap" && (
          <p>
            The deposit went through.{" "}
            {state.resume === "apply"
              ? "It is waiting to become available, and trying again only finishes that."
              : "Making it available isn't confirmed yet."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {state.retryable && !state.setupRequired && (
            <button
              type="button"
              onClick={() => void flow.retry()}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <RotateCw className="size-3.5" /> Try again
            </button>
          )}
          {state.resume === "check" && (
            <button
              type="button"
              onClick={() => void flow.check()}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <RotateCw className="size-3.5" /> Check my balances
            </button>
          )}
          {state.recheck && (
            <button
              type="button"
              onClick={() => void flow.checkAgain()}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <RotateCw className="size-3.5" /> Check again
            </button>
          )}
          {state.resume !== "check" && (
            <button
              type="button"
              onClick={flow.dismiss}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
