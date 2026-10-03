import { AppShell } from "@/components/app/app-shell"
import { PageHeader } from "@/components/app/page-header"
import { PeopleScreen } from "@/app/company/people/people-screen"

// Renders the screen without a session, against the mock store.
export default function PeopleScreenPreview() {
  return (
    <AppShell
      role="admin"
      company={{ name: "Solaris" }}
      balance={{ amount: 84000, state: "revealed" }}
    >
      <div className="space-y-6">
        <PageHeader
          eyebrow="Company"
          title="People"
          description="Everyone you pay. Each person gets an invite and sets up a private account."
        />
        <PeopleScreen />
      </div>
    </AppShell>
  )
}
