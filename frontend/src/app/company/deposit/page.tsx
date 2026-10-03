import { PageHeader } from "@/components/app/page-header"
import { DepositScreen } from "./deposit-screen"

export default function DepositPage() {
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
