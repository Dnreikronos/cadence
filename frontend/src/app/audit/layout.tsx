import { RoleShell } from "@/components/app/role-shell"
import { requireMember } from "@/lib/auth/viewer"

export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const { email, membership } = await requireMember("auditor")
  return (
    <RoleShell role="auditor" company={membership.company} email={email}>
      {children}
    </RoleShell>
  )
}
