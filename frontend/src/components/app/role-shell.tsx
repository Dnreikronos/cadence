"use client"

import { useMemo } from "react"
import { doneFromStatus, isActivated } from "@/lib/activation/machine"
import type { Role } from "@/lib/auth/guard"
import { useShellBalance } from "@/lib/queries/balance"
import { useServiceStatus } from "@/lib/queries/health"
import { useAccountStatus } from "@/lib/queries/status"
import { WalletProvider } from "@/lib/wallet/context"
import { AppShell, type ShellCompany } from "./app-shell"
import { ViewerScopeProvider } from "./viewer-scope"

// The signed-in shell with its client-side data: the balance in the sidebar, the
// service status above the screen and the wallet every screen signs with. The role
// layouts render this with what the server resolved.
export function RoleShell({
  role,
  company,
  email,
  children,
}: {
  role: Role
  company: ShellCompany
  email: string
  children: React.ReactNode
}) {
  const viewer = useMemo(
    () => ({ email, company: company.name, companyId: company.id }),
    [email, company.name, company.id],
  )
  // A recipient's balance cannot be read before their account is set up, and reading
  // it anyway is an error chip and an audit row. This is the same query, and so the
  // same single request, as the one the /me gate and /activate read.
  const status = useAccountStatus(viewer, role === "recipient")
  const activated =
    role !== "recipient" ||
    (status.data !== undefined && isActivated(doneFromStatus(status.data)))
  const balance = useShellBalance(role, viewer, activated)
  const serviceStatus = useServiceStatus()
  return (
    <WalletProvider role={role}>
      <ViewerScopeProvider viewer={viewer}>
        <AppShell
          role={role}
          company={company}
          email={email}
          balance={activated ? balance : undefined}
          serviceStatus={serviceStatus}
        >
          {children}
        </AppShell>
      </ViewerScopeProvider>
    </WalletProvider>
  )
}
