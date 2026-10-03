import { notFound } from "next/navigation"
import { PageHeader } from "@/components/app/page-header"
import { cluster } from "@/lib/solana/cluster"
import { DepositScreen } from "./deposit-screen"

export default function DepositPage() {
  // The wallet address is a mock until it comes from the real wallet (#79),
  // so never ask anyone to send real funds to it.
  if (cluster.isMainnet) notFound()
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="Deposit"
        description="Fund your company with USDC, then make it private to pay people."
      />
      <DepositScreen />
    </div>
  )
}
