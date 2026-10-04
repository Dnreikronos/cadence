"use client"

import { useId, useState } from "react"
import { Check, CircleAlert, Eye, Loader2, RotateCw } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { formatBaseUnits, toBaseUnits } from "@/lib/deposit/schema"
import { makePrivateSteps, stepLabels } from "@/lib/deposit/types"
import { formatUnits, unitsToUsd } from "@/lib/money"
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
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string>()
  // Clear the field once a deposit goes through, during render rather than in an effect.
  const [seen, setSeen] = useState(flow.state.status)
  if (seen !== flow.state.status) {
    setSeen(flow.state.status)
    if (flow.state.status === "done") setAmount("")
    // The deposit already went out (or may have): typing it again would repeat it.
    if (flow.state.status === "failed" && flow.state.resume !== "wrap") {
      setAmount("")
    }
  }

  const { state } = flow
  const isBusy = state.status === "running"
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
          isError={publicUsdc.isError && !publicUsdc.data}
          errorText="Couldn't read the network."
          onRetry={() => publicUsdc.refetch()}
        />
        <Balance
          label="Private USDC"
          hint={
            pending > 0n
              ? `${formatUnits(pending)} still becoming available`
              : "Available to pay people"
          }
          units={privateBalance.data?.available}
          isPending={privateBalance.isPending}
          isError={privateBalance.isError && !privateBalance.data}
          errorText="Couldn't load this balance."
          onRetry={() => privateBalance.refetch()}
          adornment={<WhoCanSee viewerRole="admin" hasAuditor={false} />}
        />
      </dl>

      {pending > 0n && !locked && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-line bg-surface-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-ui/normal text-ink-muted">
            {formatUnits(pending)} from an earlier deposit is waiting to become
            available. You can&apos;t pay with it until then.
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

      <form onSubmit={submit} noValidate className="mt-5 space-y-3">
        <label htmlFor={`${id}-amount`} className="text-ui font-medium">
          Amount to make private (USDC)
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
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
              aria-describedby={error ? `${id}-error` : undefined}
              className={cn(
                fieldClass,
                "h-10 pr-14 font-mono tabular-nums read-only:opacity-50 disabled:opacity-50",
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

      <div role="status" aria-live="polite">
        {(state.status === "running" || state.status === "failed") && (
          <Progress
            step={state.step}
            failed={state.status === "failed"}
            className="mt-4"
          />
        )}
        {state.status === "done" && <Done state={state} />}
      </div>

      {state.status === "failed" && <Failure flow={flow} state={state} />}

      <p className="mt-5 flex gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-ui/normal text-warning-fg">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          This step is public. The amount you move to private USDC is visible
          on-chain. What you pay out from your private balance afterwards stays
          encrypted.
        </span>
      </p>
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
  onRetry: () => void
  adornment?: React.ReactNode
}) {
  return (
    <div className="bg-surface-subtle p-4">
      <dt className="flex items-center justify-between text-label text-ink-muted uppercase">
        {label}
        {adornment}
      </dt>
      <dd className="mt-1.5">
        <AmountDisplay
          amount={units === undefined ? undefined : unitsToUsd(units)}
          state={
            units !== undefined ? "revealed" : isPending ? "loading" : "hidden"
          }
          className="text-amount"
        />
        {isError ? (
          <p role="alert" className="mt-1 text-caption text-danger-fg">
            {errorText}{" "}
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        ) : (
          <p className="mt-1 text-caption text-ink-muted">{hint}</p>
        )}
      </dd>
    </div>
  )
}

function Progress({
  step,
  failed,
  className,
}: {
  step: (typeof makePrivateSteps)[number]
  failed: boolean
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

function Done({
  state,
}: {
  state: Extract<MakePrivateState, { status: "done" }>
}) {
  return (
    <p className="mt-4 flex items-start gap-2 text-ui/normal text-ink">
      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success-dot" />
      {state.amount
        ? `${formatUnits(state.amount)} is now in your private balance. The move itself is public on-chain.`
        : "Your pending USDC is now available to pay people."}
    </p>
  )
}

function Failure({
  flow,
  state,
}: {
  flow: ReturnType<typeof useMakePrivate>
  state: Extract<MakePrivateState, { status: "failed" }>
}) {
  return (
    <div
      role="alert"
      className="mt-4 flex gap-3 rounded-lg border border-danger-border bg-danger-bg p-3 text-danger-fg"
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
        {state.resume === "apply" && (
          <p>
            The deposit went through. It is waiting to become available, and
            trying again only finishes that.
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
              onClick={flow.check}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <RotateCw className="size-3.5" /> Check my balances
            </button>
          )}
          <button
            type="button"
            onClick={flow.dismiss}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
