import { PageHeader } from "@/components/app/page-header"
import { MeScreen } from "./me-screen"

export default function MePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Recipient"
        title="Your balance"
        description="What you've been paid and what you can withdraw."
      />
      <MeScreen />
    </div>
  )
}
