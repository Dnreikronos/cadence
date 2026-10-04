"use client"

import Link from "next/link"
import { ArrowRight, Wallet } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { RECENT_PAYMENTS } from "@/lib/queries/me-options"
import { useRecentPayments } from "@/lib/queries/me"
import { BalanceCard } from "./balance-card"
import { PaymentList, PaymentListSkeleton } from "./payment-list"

export function MeScreen() {
  return (
    <div className="max-w-3xl space-y-6">
      <BalanceCard />
      <RecentPayments />
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
        <ApiErrorState
          error={recent.error}
          title="Couldn't load your payments"
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
