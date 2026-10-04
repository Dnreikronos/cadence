import { PageHeader } from "@/components/app/page-header"
import { requireMember } from "@/lib/auth/viewer"
import { MeScreen } from "./me-screen"

export default async function MePage() {
  const { email, membership } = await requireMember("recipient")
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Recipient"
        title="Your balance"
        description="What you've been paid and what you can withdraw."
      />
      <MeScreen viewer={{ email, company: membership.company.name }} />
    </div>
  )
}
