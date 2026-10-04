"use client"

import Link from "next/link"
import { ArrowRight, UserCheck, Wallet } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import type { ViewerScope } from "@/lib/queries/keys"
import { RECENT_PAYMENTS } from "@/lib/queries/me-options"
import { useMyStatus, useRecentPayments } from "@/lib/queries/me"
import { BalanceCard } from "./balance-card"
import { PaymentList, PaymentListSkeleton } from "./payment-list"

export function MeScreen({ viewer }: { viewer: ViewerScope }) {
  return (
    <div className="max-w-3xl space-y-6">
      <SetupBanner />
      <BalanceCard viewer={viewer} />
      <RecentPayments />
    </div>
  )
}

// Shown only when the service says the account is not configured. If the status
// can't be read there is no banner: the rest of the page doesn't depend on it.
function SetupBanner() {
  const status = useMyStatus()
  if (!status.data || status.data.account_configured) return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-border bg-warning-bg p-4 text-warning-fg"
    >
      <p className="flex min-w-0 flex-1 basis-64 gap-2.5 text-ui/normal">
        <UserCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">Finish setting up your account.</span>{" "}
          Until then you can&apos;t receive private payments.
        </span>
      </p>
      {/* The /activate route is not on main yet, so there is nothing to open. */}
      <span
        aria-disabled="true"
        className={buttonVariants({
          variant: "secondary",
          size: "sm",
          className: "pointer-events-none opacity-60",
        })}
      >
        Set up account (coming soon)
      </span>
    </div>
  )
}

function RecentPayments() {
  const recent = useRecentPayments()

  return (
    <section aria-labelledby="recent-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="recent-heading" className="text-lead font-medium text-ink">
          Recent payments
        </h2>
        <Link
          href="/me/history"
          className="inline-flex items-center gap-1 text-ui font-medium text-ink underline-offset-4 hover:underline"
        >
          View all
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      {!recent.data && !recent.isError ? (
        <PaymentListSkeleton rows={3} />
      ) : !recent.data ? (
        <ErrorState
          title="Couldn't load your payments"
          description="Check your connection and try again."
          onRetry={() => recent.refetch()}
        />
      ) : recent.data.items.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Nothing received yet"
          description="Payments sent to you appear here once they land."
        />
      ) : (
        <PaymentList items={recent.data.items.slice(0, RECENT_PAYMENTS)} />
      )}
    </section>
  )
}
