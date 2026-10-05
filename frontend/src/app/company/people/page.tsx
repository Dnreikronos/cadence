import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { PeopleScreen } from "./people-screen"

export const metadata: Metadata = { title: "People" }

export default function PeoplePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Company"
        title="People"
        description="Everyone you pay. Each person gets an invite and sets up a private account."
      />
      <PeopleScreen />
    </div>
  )
}
