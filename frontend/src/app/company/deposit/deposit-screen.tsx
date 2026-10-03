"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/ui/error-state"
import { useDepositInfo } from "@/lib/deposit/queries"
import { MakePrivateSection } from "./make-private-section"
import { ReceiveSection } from "./receive-section"

export function DepositScreen() {
  const deposit = useDepositInfo()

  if (deposit.isPending) {
    return (
      <div aria-busy className="max-w-3xl space-y-4">
        <span className="sr-only">Loading your wallet</span>
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }
  if (deposit.isError) {
    return (
      <ErrorState
        title="Couldn't load your wallet"
        description="Check your connection and try again."
        onRetry={() => deposit.refetch()}
      />
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      <ReceiveSection walletAddress={deposit.data.walletAddress} />
      <MakePrivateSection info={deposit.data} />
    </div>
  )
}
