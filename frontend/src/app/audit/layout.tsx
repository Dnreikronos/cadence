import { AppShell } from "@/components/app/app-shell"
import { requireMember } from "@/lib/auth/viewer"

export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const { email, membership } = await requireMember("auditor")
  return (
    <AppShell role="auditor" company={membership.company} email={email}>
      {children}
    </AppShell>
  )
}
