import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { requireMember } from "@/lib/auth/viewer"
import { AuditScreen } from "./audit-screen"

export const metadata: Metadata = { title: "Payments" }

export default async function AuditPage() {
  const { membership } = await requireMember("auditor")
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Auditor"
        title="Payments"
        description="Every payment the company made, with its amount. You can read and export them; you cannot move money."
      />
      <AuditScreen
        companyId={membership.company.id}
        company={membership.company.name}
      />
    </div>
  )
}
