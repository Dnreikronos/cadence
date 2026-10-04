"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { Check, CircleAlert, Loader2, X } from "lucide-react"
import { useViewerScope } from "@/components/app/viewer-scope"
import { buttonVariants } from "@/components/ui/button"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import {
  activationMessage,
  isTerminal,
  isWalletUnavailable,
  statusMessage,
} from "@/lib/activation/errors"
import {
  isMockMode,
  resetMockActivation,
  wantsFreshDemo,
} from "@/lib/activation/fresh"
import {
  activationSteps,
  doneFromStatus,
  isActivated,
  type ActivationState,
  type ActivationStep,
} from "@/lib/activation/machine"
import type { AccountStatus } from "@/lib/api/schemas"
import { useActivation } from "@/lib/queries/activation"
import { queryKeys } from "@/lib/queries/keys"
import { useAccountStatus } from "@/lib/queries/status"
import { cn } from "@/lib/utils"

const steps: Record<
  ActivationStep,
  { title: string; description: string; active: string }
> = {
  wallet: {
    title: "Create your wallet",
    description: "The wallet that holds your private USDC.",
    active: "Creating your wallet",
  },
  key: {
    title: "Create your balance key",
    description:
      "Your wallet signs a message in the background. You approve nothing.",
    active: "Creating your balance key",
  },
  account: {
    title: "Turn on private payments",
    description: "One setup transaction, signed by your wallet for you.",
    active: "Turning on private payments",
  },
}

export function ActivateScreen() {
  const isReady = useFreshDemo()
  return isReady ? <WithStatus /> : <ActivateSkeleton />
}

// The demo's "New recipient" opens /activate?fresh=1: forget the demo recipient's
// setup once, drop the parameter, and only then read the status, so no screen briefly
// sees the old one.
function useFreshDemo() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const wants = wantsFreshDemo(useSearchParams(), isMockMode())
  const [isReady, setIsReady] = useState(!wants)
  const started = useRef(false)

  useEffect(() => {
    if (!wants || started.current) return
    started.current = true
    resetMockActivation()
      .then(() => queryClient.resetQueries({ queryKey: queryKeys.status.all }))
      .catch(() => {})
      .finally(() => {
        setIsReady(true)
        router.replace("/activate")
      })
  }, [wants, queryClient, router])

  return isReady
}

function WithStatus() {
  const status = useAccountStatus(useViewerScope())
  if (status.data) return <Flow status={status.data} />
  if (status.isError) {
    return (
      <ApiErrorState
        error={status.error}
        title="Couldn't check your setup"
        describe={statusMessage}
        context="Nothing was changed."
        onRetry={() => status.refetch()}
      />
    )
  }
  return <ActivateSkeleton />
}

function ActivateSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your setup"
      className="max-w-2xl space-y-6"
    >
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  )
}

// Mounted once the status is known, so the flow starts from what is already done.
function Flow({ status }: { status: AccountStatus }) {
  const { state, start, wallet } = useActivation(status, useViewerScope())
  const { phase } = state
  // Whether this visit finished the setup, or found it finished.
  const [alreadySetUp] = useState(() => isActivated(doneFromStatus(status)))
  const link = useRef<HTMLAnchorElement>(null)

  // No timer takes the person anywhere (WCAG 2.2.1): the success state stays, with
  // focus on the way forward.
  useEffect(() => {
    if (phase === "done" && !alreadySetUp) link.current?.focus()
  }, [phase, alreadySetUp])

  const isRunning = phase === "running"
  const walletBlocked = wallet.status === "unavailable" && !wallet.loading
  const failure = state.failure
  const hasProgress = activationSteps.some((step) => state.done[step])

  return (
    <div className="max-w-2xl space-y-6">
      <section
        aria-labelledby="progress-heading"
        className="rounded-xl border border-line bg-surface p-5"
      >
        <h2 id="progress-heading" className="text-lead font-medium text-ink">
          {phase === "done"
            ? alreadySetUp
              ? "You're already set up"
              : "You're all set"
            : "Your setup"}
        </h2>
        <p className="mt-1 text-ui/normal text-ink-muted">
          {phase === "done"
            ? "Your account can receive private payments."
            : "Three steps, one time. Your wallet does the signing, so there is nothing to approve."}
        </p>

        {/* role: list-style: none removes the list semantics in some browsers. */}
        <ol role="list" className="mt-5 space-y-4">
          {activationSteps.map((step, index) => (
            <StepRow
              key={step}
              step={step}
              index={index}
              state={state}
              isFailed={failure?.step === step}
            />
          ))}
        </ol>

        <p role="status" aria-live="polite" className="sr-only">
          {state.current
            ? `${steps[state.current].active}.`
            : phase === "done" && !alreadySetUp
              ? "Setup finished."
              : ""}
        </p>

        <div className="mt-6">
          {phase === "done" ? (
            <Link
              ref={link}
              href="/me"
              className={buttonVariants({ size: "lg" })}
            >
              Go to your balance
            </Link>
          ) : walletBlocked ||
            (failure && isWalletUnavailable(failure.error)) ? (
            <WalletUnavailable />
          ) : failure && isTerminal(failure.error) ? (
            <ErrorState
              title={`${steps[failure.step].title} didn't finish`}
              description={activationMessage(failure.error)}
            />
          ) : (
            <>
              {failure && (
                <ErrorState
                  title={`${steps[failure.step].title} didn't finish`}
                  description={`${activationMessage(failure.error)} Steps already done stay done.`}
                  className="mb-4"
                />
              )}
              {/* One button for every state, so focus stays put across a retry. */}
              <button
                type="button"
                onClick={start}
                disabled={wallet.loading}
                aria-disabled={isRunning || undefined}
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "w-full aria-disabled:opacity-50 sm:w-auto",
                )}
              >
                {(isRunning || wallet.loading) && (
                  <Loader2
                    aria-hidden
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                )}
                {isRunning
                  ? "Setting up…"
                  : wallet.loading
                    ? "Preparing your wallet…"
                    : failure
                      ? "Try again"
                      : hasProgress
                        ? "Continue setup"
                        : "Set up my account"}
              </button>
            </>
          )}
        </div>
      </section>

      <WhoSeesWhat />
    </div>
  )
}

function StepRow({
  step,
  index,
  state,
  isFailed,
}: {
  step: ActivationStep
  index: number
  state: ActivationState
  isFailed: boolean
}) {
  const isDone = state.done[step]
  const isActive = state.current === step
  const { title, description } = steps[step]
  return (
    <li aria-current={isActive ? "step" : undefined} className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-caption",
          isDone
            ? "border-success-border bg-success-bg text-success-fg"
            : isFailed
              ? "border-danger-border bg-danger-bg text-danger-fg"
              : isActive
                ? "border-ink text-ink"
                : "border-line text-ink-muted",
        )}
      >
        {isDone ? (
          <Check className="size-3.5" />
        ) : isFailed ? (
          <X className="size-3.5" />
        ) : isActive ? (
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          index + 1
        )}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-ui font-medium",
            isDone || isActive || isFailed ? "text-ink" : "text-ink-muted",
          )}
        >
          {title}
          <span className="sr-only">
            {isDone
              ? ": done"
              : isFailed
                ? ": failed"
                : isActive
                  ? ": in progress"
                  : ": not started"}
          </span>
        </p>
        <p className="text-caption/normal text-ink-muted">{description}</p>
      </div>
    </li>
  )
}

function WalletUnavailable() {
  return (
    <div
      role="status"
      className="flex gap-3 rounded-xl border border-warning-border bg-warning-bg p-4 text-warning-fg"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-ui font-medium">
          Wallet creation is not available yet
        </p>
        <p className="mt-0.5 text-ui/normal">
          You can&apos;t finish setting up until it is. Nothing has changed on
          your account, and you can come back to this page later.
        </p>
      </div>
    </div>
  )
}

function WhoSeesWhat() {
  return (
    <section
      aria-labelledby="who-sees-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <div className="flex items-center gap-1.5">
        <h2 id="who-sees-heading" className="text-lead font-medium text-ink">
          Who sees what
        </h2>
        <WhoCanSee
          viewerRole="recipient"
          hasAuditor={false}
          label="Who can see your payments"
          description="You, the company that pays you, any auditor it appoints and Cadence can read the amounts of your payments. The public cannot: on-chain they are ciphertext."
          cadenceLine="Cadence aims to log every read of an amount."
        />
      </div>
      <dl className="mt-4 space-y-3 text-ui/normal">
        <Reader name="You">
          see your balance and every payment sent to you.
        </Reader>
        <Reader name="The company that pays you">
          sees the amount of every payment it sends you. So does an auditor it
          appoints.
        </Reader>
        <Reader name="Cadence">
          can read amounts too. Setting up sends a signature from your wallet to
          Cadence, which uses it to derive the keys it holds for you. With them
          it can read the amounts of your payments and prove they are valid.
          Cadence aims to log every read.
        </Reader>
        <Reader name="The public">
          sees that you have an account and that payments happen. Payments are
          encrypted on-chain, so the amount is hidden. Deposits and withdrawals
          are public.
        </Reader>
      </dl>
      <p className="mt-4 text-caption/normal text-ink-muted">
        Account recovery isn&apos;t available yet.
      </p>
    </section>
  )
}

function Reader({
  name,
  children,
}: {
  name: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="inline font-medium text-ink">{name} </dt>
      <dd className="inline text-ink-muted">{children}</dd>
    </div>
  )
}
