"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { ArrowUpFromLine, Loader2 } from "lucide-react"
import { useViewerScope } from "@/components/app/viewer-scope"
import { buttonVariants } from "@/components/ui/button"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { balanceReaders } from "@/lib/me/copy"
import { applyPendingMessage } from "@/lib/me/apply-pending"
import { lastApplyMessage } from "@/lib/me/last-apply"
import { useMyBalance } from "@/lib/queries/balance"
import { useApplyPending } from "@/lib/queries/me"
import { Units } from "./units"

export function BalanceCard() {
  const balance = useMyBalance(useViewerScope())
  const apply = useApplyPending(balance.data)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)

  // The button that was pressed is disabled or gone by now: keep the keyboard here.
  useEffect(() => {
    if (apply.succeeded) headingRef.current?.focus()
  }, [apply.succeeded])
  useEffect(() => {
    if (apply.error) alertRef.current?.focus()
  }, [apply.error])

  if (!balance.data && !balance.isError) {
    return (
      <div aria-busy className="rounded-xl border border-line bg-surface p-5">
        <span className="sr-only">Loading your balance</span>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-9 w-48" />
        <Skeleton className="mt-6 h-14 w-full rounded-lg" />
      </div>
    )
  }
  if (!balance.data) {
    return (
      <ApiErrorState
        error={balance.error}
        title="Couldn't load your balance"
        context="Your balance is safe."
        onRetry={() => balance.refetch()}
      />
    )
  }

  const { available, pending } = balance.data
  const hasPending = BigInt(pending) > 0n
  const { ui } = apply
  const note =
    ui.status ??
    lastApplyMessage(apply.last) ??
    (apply.settle === "timed-out"
      ? "Your balance hasn't refreshed yet. If it still shows pending credits, you can apply again."
      : null)

  return (
    <section
      aria-labelledby="balance-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="balance-heading"
            ref={headingRef}
            tabIndex={-1}
            className="flex items-center gap-1.5 text-label text-ink-muted uppercase outline-none"
          >
            Available
            <WhoCanSee viewerRole="recipient" hasAuditor={undefined} />
          </h2>
          <p className="mt-1.5">
            <Units units={available} className="text-amount" />
          </p>
          <p className="mt-1 text-caption text-ink-muted">{balanceReaders}</p>
        </div>
        <Link
          href="/me/withdraw"
          className={buttonVariants({ variant: "secondary" })}
        >
          <ArrowUpFromLine className="size-4" />
          Withdraw
        </Link>
      </div>

      {ui.visible ? (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {hasPending ? (
                <>
                  <p className="flex items-center gap-1.5 text-ui font-medium text-ink">
                    <Units units={pending} />
                    pending
                  </p>
                  <p className="mt-0.5 max-w-prose text-caption/normal text-ink-muted">
                    Incoming payments wait here until you apply them. Applying
                    is one transaction your wallet signs, and it adds them to
                    what you can withdraw.
                  </p>
                </>
              ) : (
                <p className="text-ui text-ink-muted">Nothing pending.</p>
              )}
            </div>
            {hasPending && (
              <button
                type="button"
                disabled={!ui.canApply}
                onClick={apply.apply}
                className={buttonVariants()}
              >
                {!ui.canApply && ui.status && (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                )}
                {ui.label}
              </button>
            )}
          </div>

          <p role="status" className="text-caption text-ink-muted">
            {note}
          </p>

          {(ui.sentFailure ||
            ui.retryable ||
            apply.lock === "check-failed") && (
            <div
              role="alert"
              ref={alertRef}
              tabIndex={-1}
              className="space-y-2 text-ui text-danger-fg outline-none"
            >
              <p>
                {apply.error
                  ? applyPendingMessage(apply.error)
                  : "We couldn't check your last update. Try again in a moment."}
              </p>
              {(ui.sentFailure || apply.lock === "check-failed") && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void apply.checkBalance()}
                    className={buttonVariants({
                      variant: "secondary",
                      size: "sm",
                    })}
                  >
                    Check my balance
                  </button>
                  {apply.lock === "check-failed" && (
                    <button
                      type="button"
                      onClick={apply.checkAgain}
                      className={buttonVariants({
                        variant: "secondary",
                        size: "sm",
                      })}
                    >
                      Check again
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {!apply.walletReady && !apply.walletLoading && hasPending && (
            <p className="text-caption/normal text-ink-muted">
              Your wallet isn&apos;t connected in this version, so pending
              payments can&apos;t be applied yet.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-5 border-t border-line pt-4 text-ui text-ink-muted">
          Nothing pending. New payments show up here first.
        </p>
      )}
    </section>
  )
}
