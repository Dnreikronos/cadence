import { notFound } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { PageHeader } from "@/components/app/page-header"
import { DepositScreen } from "@/app/company/deposit/deposit-screen"
import { PeopleScreen } from "@/app/company/people/people-screen"
import { AuditorsScreen } from "@/app/company/auditors/auditors-screen"
import { WalletProvider } from "@/lib/wallet/context"

// Renders a company screen without a session, against the mock stores. The real
// routes sit behind the role guard, which needs a local Supabase and an admin.
const screens = {
  people: {
    title: "People",
    description:
      "Everyone you pay. Each person gets an invite and sets up a private account.",
    Screen: PeopleScreen,
  },
  deposit: {
    title: "Deposit",
    description:
      "Fund your company with USDC, then make it private to pay people.",
    Screen: DepositScreen,
  },
  auditors: {
    title: "Auditors",
    description:
      "People who can see every payment amount, like your accountant. They need no wallet.",
    Screen: AuditorsScreen,
  },
} as const

export function generateStaticParams() {
  return Object.keys(screens).map((screen) => ({ screen }))
}

export default async function ScreenPreview({
  params,
}: {
  params: Promise<{ screen: string }>
}) {
  const { screen } = await params
  if (!Object.hasOwn(screens, screen)) notFound()
  const { title, description, Screen } = screens[screen as keyof typeof screens]

  return (
    <WalletProvider role="admin">
      <AppShell
        role="admin"
        company={{ name: "Solaris" }}
        email="ana@solaris.test"
        balance={{ amount: 84000, state: "revealed" }}
      >
        <div className="space-y-6">
          <PageHeader
            eyebrow="Company"
            title={title}
            description={description}
          />
          <Screen />
        </div>
      </AppShell>
    </WalletProvider>
  )
}
