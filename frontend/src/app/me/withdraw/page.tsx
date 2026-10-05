import { PageHeader } from "@/components/app/page-header"
import { requireMember } from "@/lib/auth/viewer"
import { WithdrawScreen } from "./withdraw-screen"

export default async function WithdrawPage() {
  const { email, membership } = await requireMember("recipient")
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Recipient"
        title="Withdraw"
        description="Move your private USDC to your wallet, then cash it out."
      />
      <WithdrawScreen
        viewer={{
          email,
          company: membership.company.name,
          companyId: membership.company.id,
        }}
      />
    </div>
  )
}
