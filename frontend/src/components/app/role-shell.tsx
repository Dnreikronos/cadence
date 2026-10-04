"use client"

import type { Role } from "@/lib/auth/guard"
import { useShellBalance } from "@/lib/queries/balance"
import { WalletProvider } from "@/lib/wallet/context"
import { AppShell, type ShellCompany } from "./app-shell"

// The signed-in shell with its client-side data: the balance in the sidebar and the
// wallet every screen signs with. The role layouts render this with what the server resolved.
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
  const balance = useShellBalance(role)
  return (
    <WalletProvider role={role}>
      <AppShell role={role} company={company} email={email} balance={balance}>
        {children}
      </AppShell>
    </WalletProvider>
  )
}
