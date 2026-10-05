import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { HistoryScreen } from "./history-screen"

export const metadata: Metadata = { title: "History" }

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Recipient"
        title="History"
        description="Every payment you've received. Open one for its receipt."
      />
      <HistoryScreen />
    </div>
  )
}
