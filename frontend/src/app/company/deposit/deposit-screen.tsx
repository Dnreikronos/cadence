"use client"

import { Wallet } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useWallet } from "@/lib/wallet/context"
import { MakePrivateSection } from "./make-private-section"
import { ReceiveSection } from "./receive-section"

export function DepositScreen() {
  const wallet = useWallet()

  if (wallet.loading) {
    return (
      <div aria-busy className="max-w-3xl space-y-4">
        <span className="sr-only">Loading your wallet</span>
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    )
  }
  if (wallet.status === "unavailable") {
    return (
      <EmptyState
        icon={Wallet}
        title="Your company wallet isn't available yet"
        description="Deposits need a wallet that can sign. It isn't set up in this environment yet."
        className="max-w-3xl"
      />
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      <ReceiveSection walletAddress={wallet.address} />
      <MakePrivateSection wallet={wallet.address} />
    </div>
  )
}
