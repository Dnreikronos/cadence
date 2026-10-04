import { PageHeader } from "@/components/app/page-header"
import { HistoryScreen } from "./history-screen"

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
