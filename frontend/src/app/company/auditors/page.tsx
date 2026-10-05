import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { AuditorsScreen } from "./auditors-screen"

export const metadata: Metadata = { title: "Auditors" }

export default function AuditorsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="Auditors"
        description="People who can see every payment amount, like your accountant. They need no wallet."
      />
      <AuditorsScreen />
    </div>
  )
}
