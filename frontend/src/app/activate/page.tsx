import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { ActivateScreen } from "./activate-screen"

export const metadata: Metadata = { title: "Set up your account" }

export default function ActivatePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Recipient"
        title="Set up your account"
        description="A one-time setup so you can receive private payments."
      />
      <ActivateScreen />
    </div>
  )
}
