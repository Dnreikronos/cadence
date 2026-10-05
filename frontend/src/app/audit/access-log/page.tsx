import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { requireMember } from "@/lib/auth/viewer"
import { AccessLogScreen } from "./access-log-screen"

export const metadata: Metadata = { title: "Access log" }

export default async function AccessLogPage() {
  const { membership } = await requireMember("auditor")
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Auditor"
        title="Access log"
        description="Who read company data, and when."
      />
      <AccessLogScreen company={membership.company.name} />
    </div>
  )
}
