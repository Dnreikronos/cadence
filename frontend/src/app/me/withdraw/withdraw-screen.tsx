"use client"

import { useEffect, useId, useReducer, useRef, useState } from "react"
import Link from "next/link"
import { Check, Eye, Loader2, TriangleAlert } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { ButtonCopy } from "@/components/ui/button-copy"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { fieldClass } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { isApiError, messageFor } from "@/lib/api"
import type { ViewerScope } from "@/lib/queries/keys"
import { useMyBalance } from "@/lib/queries/balance"
import {
  useSentWithdrawal,
  useWithdraw,
  useWithdrawInFlight,
} from "@/lib/queries/withdraw"
import { formatBaseUnits, unitsToUsd } from "@/lib/money"
import { useWallet } from "@/lib/wallet/context"
import {
  failureOf,
  initialWithdraw,
  phaseLabels,
  phases,
  sentMessage,
  withdrawReducer,
  type Held,
  type Phase,
  type WithdrawState,
} from "@/lib/withdraw/flow"
import { acknowledgePrompt, riskView } from "@/lib/withdraw/risk"
import { maxWithdrawUnits, toWithdrawUnits } from "@/lib/withdraw/schema"
import { cn } from "@/lib/utils"
import { CashOutPanel } from "./cash-out-panel"
import { RevealRiskBadge } from "./reveal-risk-badge"

export function WithdrawScreen({ viewer }: { viewer: ViewerScope }) {
  const wallet = useWallet()
  const balance = useMyBalance(viewer)

  if (wallet.loading || balance.isPending) {
    return (
      <div aria-busy className="max-w-3xl space-y-4">
        <span className="sr-only">Loading your balance</span>
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      {balance.isError ? (
        <ErrorState
          title="Couldn't load your balance"
          description={messageFor(balance.error)}
          onRetry={
            isApiError(balance.error) && !balance.error.isRetryable
              ? undefined
              : () => balance.refetch()
          }
        />
      ) : wallet.status === "unavailable" ? (
        <EmptyState
          icon={Eye}
          title="Withdrawals aren't available yet"
          description="Your wallet can't sign in this environment, so there is nothing to withdraw with."
        />
      ) : (
        <WithdrawCard
          available={BigInt(balance.data.available)}
          pending={BigInt(balance.data.pending)}
        />
      )}
      <CashOutPanel />
    </div>
  )
}

function WithdrawCard({
  available,
  pending,
}: {
  available: bigint
  pending: bigint
}) {
  const id = useId()
  const withdraw = useWithdraw()
  const sent = useSentWithdrawal()
  const [state, dispatch] = useReducer(
    withdrawReducer,
    sent,
    (held): WithdrawState => ({ ...initialWithdraw, held }),
  )
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string>()
  const [ackError, setAckError] = useState<string>()
  const inFlight = useWithdrawInFlight()
  const amountField = useRef<HTMLInputElement>(null)
  const checkbox = useRef<HTMLInputElement>(null)
  const done = useRef<HTMLHeadingElement>(null)
  const refocus = useRef(false)

  const isBusy = state.stage === "working"
  const hasFunds = available > 0n
  const stage = state.stage

  // Ones that finished unresolved while this screen was closed. A no-op once they are held.
  useEffect(() => {
    dispatch({ type: "hold", held: sent })
  }, [sent])

  // Move focus to what just appeared, so a keyboard or screen-reader user lands on it.
  useEffect(() => {
    if (stage === "needs-acknowledgement") checkbox.current?.focus()
    if (stage === "done") done.current?.focus()
    if (stage === "form" && refocus.current) {
      refocus.current = false
      amountField.current?.focus()
    }
  }, [stage])

  function edit(next: string) {
    setAmount(next)
    setError(undefined)
    setAckError(undefined)
    dispatch({ type: "amount-changed" })
  }

  function start() {
    if (isBusy || inFlight) return
    const parsed = toWithdrawUnits(amount, available)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }
    const units = parsed.units.toString()
    // Seeded here, not left to the effect above, so a failure that landed this very
    // render is already counted.
    const current = withdrawReducer(state, { type: "hold", held: sent })
    const next = withdrawReducer(current, { type: "submit", amount: units })
    if (next.stage !== "working") {
      if (state.stage === "needs-acknowledgement") {
        // Asked to agree, and has not yet.
        setAckError("Tick the box to confirm you understand.")
        checkbox.current?.focus()
      } else {
        // The reducer holds an amount that may already have gone out.
        setError(
          "A withdrawal for this amount may already have gone through. Check your balance and history, or change the amount.",
        )
      }
      return
    }
    setError(undefined)
    setAckError(undefined)
    dispatch({ type: "hold", held: sent })
    dispatch({ type: "submit", amount: units })
    withdraw.mutate(
      {
        amount: units,
        acknowledged: next.acknowledged,
        onPrepared: (level) => dispatch({ type: "prepared", level }),
        onStep: (step) => dispatch({ type: "step", step }),
      },
      {
        onSuccess: (outcome) =>
          dispatch(
            outcome.kind === "done"
              ? {
                  type: "succeeded",
                  level: outcome.level,
                  signature: outcome.receipt.signature,
                }
              : { type: "needs-acknowledgement" },
          ),
        onError: (failure) =>
          dispatch({ type: "failed", failure: failureOf(failure) }),
      },
    )
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    start()
  }

  // The reducer refuses this amount while it may already have gone out; the button says so too.
  const typed = toWithdrawUnits(amount, available)
  const isHeld =
    typed.ok && state.held.some((h) => h.amount === typed.units.toString())

  if (inFlight && state.stage === "form") {
    return (
      <section
        role="status"
        className="rounded-xl border border-line bg-surface p-5"
      >
        <h2 className="flex items-center gap-2 text-lead font-medium text-ink">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          A withdrawal is already in progress
        </h2>
        <p className="mt-2 text-ui/normal text-ink-muted">
          It was started before you left this page and is still running. You can
          withdraw again once it finishes. Your balance and history show the
          result.
        </p>
      </section>
    )
  }

  if (state.stage === "done") {
    return (
      <Done
        state={state}
        headingRef={done}
        onAgain={() => {
          setAmount("")
          refocus.current = true
          dispatch({ type: "reset" })
        }}
      />
    )
  }

  return (
    <section
      aria-labelledby="withdraw-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <h2 id="withdraw-heading" className="text-lead font-medium text-ink">
        Withdraw to your wallet
      </h2>
      <p className="mt-1 text-ui/normal text-ink-muted">
        Move USDC from your private balance to your wallet, where it is an
        ordinary public balance.
      </p>

      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        <div className="bg-surface-subtle p-4">
          <dt className="flex items-center justify-between text-label text-ink-muted uppercase">
            Available to withdraw
            <WhoCanSee viewerRole="recipient" hasAuditor={false} />
          </dt>
          <dd className="mt-1.5">
            <AmountDisplay
              amount={unitsToUsd(available)}
              className="text-amount"
            />
          </dd>
        </div>
        <div className="bg-surface-subtle p-4">
          <dt className="text-label text-ink-muted uppercase">Pending</dt>
          <dd className="mt-1.5">
            <AmountDisplay
              amount={unitsToUsd(pending)}
              className="text-amount"
            />
            {pending > 0n && (
              <p className="mt-1 text-caption text-ink-muted">
                <Link
                  href="/me"
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Apply it
                </Link>{" "}
                to make it available.
              </p>
            )}
          </dd>
        </div>
      </dl>

      <form onSubmit={submit} noValidate className="mt-5 space-y-3">
        <label htmlFor={`${id}-amount`} className="text-ui font-medium">
          Amount to withdraw (USDC)
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              ref={amountField}
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              disabled={!hasFunds}
              readOnly={isBusy}
              value={amount}
              onChange={(event) => edit(event.target.value)}
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
              aria-disabled={isBusy || undefined}
              onClick={() => {
                if (isBusy) return
                edit(formatBaseUnits(maxWithdrawUnits(available)))
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md px-2 py-1 text-caption font-medium text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-50 aria-disabled:opacity-50"
            >
              Max
            </button>
          </div>
          {state.stage !== "needs-acknowledgement" && (
            <button
              type="submit"
              disabled={!hasFunds}
              aria-disabled={isBusy || isHeld || undefined}
              aria-describedby={isHeld ? `${id}-held` : undefined}
              className={cn(
                buttonVariants({ size: "lg" }),
                "aria-disabled:opacity-50",
              )}
            >
              {isBusy && (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              )}
              {isBusy ? "Working…" : "Withdraw"}
            </button>
          )}
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
        {!hasFunds && (
          <p className="text-caption/normal text-ink-muted">
            You have nothing to withdraw yet. Payments you receive show up on
            your{" "}
            <Link
              href="/me"
              className="underline underline-offset-2 hover:text-ink"
            >
              balance
            </Link>
            .
          </p>
        )}

        {state.stage === "needs-acknowledgement" && (
          <Acknowledge
            id={id}
            state={state}
            error={ackError}
            checkboxRef={checkbox}
            onChange={(value) => {
              setAckError(undefined)
              dispatch({ type: "acknowledge", value })
            }}
          />
        )}
      </form>

      <div role="status" aria-live="polite">
        {state.stage === "working" && <Progress state={state} />}
      </div>

      {state.held.length > 0 && (
        <div id={`${id}-held`} className="space-y-3">
          {state.held.map((held) => (
            <HeldNotice
              key={held.amount}
              held={held}
              isAlert={
                state.stage === "failed" &&
                state.failure.sent &&
                state.amount === held.amount
              }
            />
          ))}
        </div>
      )}

      {state.stage === "failed" && !state.failure.sent && (
        <ErrorState
          className="mt-4"
          title="The withdrawal didn't go through"
          description={state.failure.message}
          onRetry={state.failure.retryable ? start : undefined}
        />
      )}

      <p className="mt-5 flex gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-ui/normal text-warning-fg">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Withdrawals are public. The amount and your wallet address are visible
          on-chain to anyone. Payments you receive stay encrypted on-chain, but
          Cadence and the company that paid you can read their amounts.
        </span>
      </p>
    </section>
  )
}

function Acknowledge({
  id,
  state,
  error,
  checkboxRef,
  onChange,
}: {
  id: string
  state: Extract<WithdrawState, { stage: "needs-acknowledgement" }>
  error?: string
  checkboxRef: React.RefObject<HTMLInputElement | null>
  onChange: (value: boolean) => void
}) {
  const body = `${id}-risk-body`
  const hint = `${id}-risk-hint`
  const errorId = `${id}-risk-error`
  return (
    <div
      role="group"
      aria-labelledby={`${id}-risk-title`}
      className="space-y-3 rounded-lg border border-warning-border bg-warning-bg p-4 text-warning-fg"
    >
      <p
        id={`${id}-risk-title`}
        className="flex items-start gap-2 text-ui font-medium"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        {acknowledgePrompt.title}
      </p>
      <p id={body} className="text-ui/normal">
        {acknowledgePrompt.body}
      </p>
      <p id={hint} className="text-ui/normal">
        {acknowledgePrompt.hint}
      </p>
      <label className="flex cursor-pointer items-start gap-2 text-ui/normal text-ink">
        <input
          ref={checkboxRef}
          type="checkbox"
          required
          checked={state.acknowledged}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={!!error}
          aria-describedby={`${body} ${hint}${error ? ` ${errorId}` : ""}`}
          className="mt-0.5 size-4 shrink-0 accent-ink"
        />
        {acknowledgePrompt.checkbox}
      </label>
      {error && (
        <p id={errorId} role="alert" className="text-caption text-danger-fg">
          {error}
        </p>
      )}
      <button
        type="submit"
        aria-disabled={!state.acknowledged || undefined}
        className={cn(
          buttonVariants({ size: "lg" }),
          "aria-disabled:opacity-50",
        )}
      >
        Withdraw anyway
      </button>
    </div>
  )
}

// A withdrawal that may already have gone through. It stays until the page reloads, and
// the reducer will not send the same amount again meanwhile.
function HeldNotice({ held, isAlert }: { held: Held; isAlert: boolean }) {
  return (
    <div
      role={isAlert ? "alert" : undefined}
      className="mt-4 flex gap-3 rounded-xl border border-warning-border bg-warning-bg p-4 text-warning-fg"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-2 text-ui/normal">
        <p className="font-medium">The withdrawal may have gone through</p>
        <p>{sentMessage}</p>
        {held.signature && (
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <p className="text-label uppercase">Signature</p>
              <p className="mt-1 font-mono text-caption/normal break-all">
                {held.signature}
              </p>
            </div>
            <ButtonCopy
              value={held.signature}
              label="Copy signature"
              toastTitle="Signature copied"
            />
          </div>
        )}
        <p>
          Another amount can still be withdrawn. To withdraw this amount again,
          first check your balance, then reload this page.
        </p>
      </div>
    </div>
  )
}

function Progress({
  state,
}: {
  state: Extract<WithdrawState, { stage: "working" }>
}) {
  const current = phases.indexOf(state.phase)
  return (
    <div className="mt-4">
      <ol className="space-y-1.5">
        {phases.map((name, index) => {
          const status =
            index < current ? "done" : index === current ? "active" : "todo"
          return (
            <li
              key={name}
              className={cn(
                "flex items-center gap-2 text-ui",
                status === "todo" ? "text-ink-muted" : "text-ink",
              )}
            >
              <span className="grid size-4 place-items-center">
                {status === "done" && (
                  <Check className="size-3.5 text-success-dot" />
                )}
                {status === "active" && (
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {status === "todo" && (
                  <span className="size-1.5 rounded-full bg-line" />
                )}
              </span>
              {phaseLabels[name as Phase]}
            </li>
          )
        })}
      </ol>
      {state.level && <RiskNote level={state.level} className="mt-3" />}
    </div>
  )
}

function RiskNote({
  level,
  className,
}: {
  level: Extract<WithdrawState, { stage: "done" }>["level"]
  className?: string
}) {
  const view = riskView(level)
  return (
    <div className={cn("space-y-1", className)}>
      <RevealRiskBadge level={level} />
      {view.explanation && (
        <p className="text-caption/normal text-ink-muted">{view.explanation}</p>
      )}
    </div>
  )
}

function Done({
  state,
  headingRef,
  onAgain,
}: {
  state: Extract<WithdrawState, { stage: "done" }>
  headingRef: React.RefObject<HTMLHeadingElement | null>
  onAgain: () => void
}) {
  return (
    <section
      aria-labelledby="done-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <h2
        id="done-heading"
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-lead font-medium text-ink outline-none"
      >
        <span className="grid size-5 place-items-center rounded-full bg-success-bg text-success-fg">
          <Check aria-hidden className="size-3" />
        </span>
        Withdrawal complete
      </h2>
      <p className="mt-4 text-label text-ink-muted uppercase">Withdrawn</p>
      <AmountDisplay
        amount={unitsToUsd(state.amount)}
        className="mt-1 text-amount"
      />
      <RiskNote level={state.level} className="mt-3" />
      <p className="mt-4 text-ui/normal text-ink-muted">
        The USDC is in your wallet. This withdrawal is public: anyone can see
        the amount arriving at your wallet address. To turn it into reais, see
        Cash out below.
      </p>
      <div className="mt-4 flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-label text-ink-muted uppercase">Signature</p>
          <p className="mt-1 font-mono text-caption/normal break-all text-ink">
            {state.signature}
          </p>
        </div>
        <ButtonCopy
          value={state.signature}
          label="Copy signature"
          toastTitle="Signature copied"
        />
      </div>
      <button
        type="button"
        onClick={onAgain}
        className={buttonVariants({
          variant: "secondary",
          className: "mt-5",
        })}
      >
        Withdraw again
      </button>
    </section>
  )
}
