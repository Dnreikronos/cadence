import { PageHeader } from "@/components/app/page-header"
import { requireMember } from "@/lib/auth/viewer"
import { NewRunScreen } from "./new-run-screen"

export default async function NewRunPage() {
  const { email, membership } = await requireMember("admin")
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="New payroll run"
        description="Choose who to pay. You approve once, then sign each payment in turn."
      />
      <NewRunScreen
        viewer={{
          email,
          company: membership.company.name,
          companyId: membership.company.id,
        }}
      />
    </div>
  )
}
