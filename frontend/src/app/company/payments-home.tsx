"use client"

import Link from "next/link"
import { ArrowDownToLine, ArrowRight, Plus, Send } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import type { PaymentItem } from "@/lib/api/schemas"
import { unitsToUsd } from "@/lib/money"
import { useRecentPayments } from "@/lib/queries/payroll"
import { runMessage } from "@/lib/runs/messages"
import { initialsOf } from "@/lib/runs/people"

const recentCount = 10

export function PaymentsHome() {
  const payments = useRecentPayments(recentCount)

  const newRun = (
    <Link href="/company/runs/new" className={buttonVariants()}>
      <Plus className="size-4" />
      New payroll run
    </Link>
  )

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap gap-2">
        {newRun}
        <Link
          href="/company/deposit"
          className={buttonVariants({ variant: "secondary" })}
        >
          <ArrowDownToLine className="size-4" />
          Deposit USDC
        </Link>
      </div>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="recent-heading"
            className="flex items-center gap-1.5 text-lead font-medium text-ink"
          >
            Recent payments
            <WhoCanSee viewerRole="admin" hasAuditor={false} />
          </h2>
          <Link
            href="/company/receipts"
            className="inline-flex items-center gap-1 text-ui text-ink-muted hover:text-ink"
          >
            All receipts
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>

        {!payments.data ? (
          payments.isError ? (
            <ErrorState
              title="Couldn't load your payments"
              description={runMessage(payments.error)}
              onRetry={() => payments.refetch()}
            />
          ) : (
            <PaymentsSkeleton />
          )
        ) : payments.data.items.length === 0 ? (
          <EmptyState
            icon={Send}
            title="No payments yet"
            description="Deposit USDC, then pay your first recipient."
            action={newRun}
          />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface">
            {payments.data.items.map((payment) => (
              <PaymentRow key={payment.payment_id} payment={payment} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function PaymentRow({ payment }: { payment: PaymentItem }) {
  const { counterparty } = payment
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:border-0">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <span aria-hidden>
          <AvatarPerson initials={initialsOf(counterparty.name)} size={30} />
        </span>
        <span className="min-w-0">
          <span className="block text-ui font-medium wrap-break-word text-ink">
            {counterparty.name}
          </span>
          <span className="block text-caption text-ink-muted">
            <time dateTime={payment.paid_at}>
              {new Date(payment.paid_at).toLocaleDateString("en-US", {
                dateStyle: "medium",
              })}
            </time>
            {payment.run_id && (
              <>
                {" · "}
                <Link
                  href={`/company/runs/${payment.run_id}`}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Payroll run
                </Link>
              </>
            )}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={payment.status} />
        {payment.transparent && <TransparentBadge />}
      </span>
      <AmountDisplay
        amount={unitsToUsd(payment.amount)}
        className="min-w-24 text-right text-ui"
      />
    </li>
  )
}

function PaymentsSkeleton() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading payments</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="size-7.5 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}
