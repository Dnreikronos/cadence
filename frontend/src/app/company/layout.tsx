import { AppShell } from "@/components/app/app-shell"
import { pendingBalance } from "@/components/app/pending-membership"
import { requireMember } from "@/lib/auth/viewer"

export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const { email, membership } = await requireMember("admin")
  return (
    <AppShell
      role="admin"
      company={membership.company}
      email={email}
      balance={pendingBalance}
    >
      {children}
    </AppShell>
  )
}
