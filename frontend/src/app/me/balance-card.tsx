"use client"

import Link from "next/link"
import { ArrowUpFromLine, Loader2 } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { applyPendingMessage } from "@/lib/me/apply-pending"
import { unitsToUsd } from "@/lib/money"
import { useApplyPending } from "@/lib/queries/me"
import { useMyBalance } from "@/lib/queries/withdraw"
import type { ViewerScope } from "@/lib/queries/keys"
import { useWallet } from "@/lib/wallet/context"
import type { SignStep } from "@/lib/api/sign"

const stepLabels: Record<SignStep, string> = {
  signing: "Signing…",
  submitting: "Sending…",
  confirming: "Confirming…",
}

export function BalanceCard({ viewer }: { viewer: ViewerScope }) {
  const balance = useMyBalance(viewer)

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
      <ErrorState
        title="Couldn't load your balance"
        description="Your balance is safe. Check your connection and try again."
        onRetry={() => balance.refetch()}
      />
    )
  }

  const { available, pending } = balance.data
  const hasPending = BigInt(pending) > 0n

  return (
    <section
      aria-labelledby="balance-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="balance-heading"
            className="flex items-center gap-1.5 text-label text-ink-muted uppercase"
          >
            Available
            <WhoCanSee viewerRole="recipient" hasAuditor={undefined} />
          </h2>
          <p className="mt-1.5">
            <AmountDisplay
              amount={unitsToUsd(available)}
              className="text-amount"
            />
          </p>
          <p className="mt-1 text-caption text-ink-muted">
            Ready to withdraw. It is encrypted on-chain, but the company that
            paid you and Cadence can read it.
          </p>
        </div>
        <Link
          href="/me/withdraw"
          className={buttonVariants({ variant: "secondary" })}
        >
          <ArrowUpFromLine className="size-4" />
          Withdraw
        </Link>
      </div>

      {hasPending ? (
        <PendingPanel pending={pending} />
      ) : (
        <p className="mt-5 border-t border-line pt-4 text-ui text-ink-muted">
          Nothing pending. New payments show up here first.
        </p>
      )}
    </section>
  )
}

function PendingPanel({ pending }: { pending: string }) {
  const apply = useApplyPending()
  const wallet = useWallet()
  const blocked = wallet.status !== "ready"
  const busy = apply.isPending

  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-ui font-medium text-ink">
            <AmountDisplay amount={unitsToUsd(pending)} />
            pending
          </p>
          <p className="mt-0.5 max-w-prose text-caption/normal text-ink-muted">
            Incoming payments wait here until you apply them. Applying is one
            transaction your wallet signs, and it adds them to what you can
            withdraw.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || blocked}
          onClick={() => apply.mutate()}
          className={buttonVariants()}
        >
          {busy && (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          )}
          {busy
            ? apply.step
              ? stepLabels[apply.step]
              : "Working…"
            : wallet.loading
              ? "Preparing wallet…"
              : apply.isError
                ? "Try again"
                : "Apply pending"}
        </button>
      </div>
      {apply.isError && (
        <p role="alert" className="text-ui text-danger-fg">
          {applyPendingMessage(apply.error)}
        </p>
      )}
      {blocked && !wallet.loading && (
        <p className="text-caption/normal text-ink-muted">
          Your wallet isn&apos;t connected in this version, so pending payments
          can&apos;t be applied yet.
        </p>
      )}
    </div>
  )
}
