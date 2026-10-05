import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { ReceiptsScreen } from "./receipts-screen"

export const metadata: Metadata = { title: "Receipts" }

export default function ReceiptsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="Receipts"
        description="Every payment your company has made, with a receipt for each one."
      />
      <ReceiptsScreen />
    </div>
  )
}
