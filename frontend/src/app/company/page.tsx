import { PageHeader } from "@/components/app/page-header"
import { PaymentsHome } from "./payments-home"

export default function CompanyPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="Payments"
        description="Pay your people from your private balance. Amounts are encrypted on-chain; you, the recipient, any auditor and Cadence can read them."
      />
      <PaymentsHome />
    </div>
  )
}
