import { notFound } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { PageHeader } from "@/components/app/page-header"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import type { Role } from "@/lib/auth/guard"
import { samplePayments } from "../../sample"

const roles: Role[] = ["admin", "recipient", "auditor"]

export default async function ShellPreview({
  params,
}: {
  params: Promise<{ role: string }>
}) {
  const { role } = await params
  if (!roles.includes(role as Role)) notFound()
  const viewerRole = role as Role
  const payments =
    viewerRole === "recipient" ? samplePayments.slice(0, 1) : samplePayments

  return (
    <AppShell
      role={viewerRole}
      company={{ name: "Solaris" }}
      email="ana@solaris.test"
      balance={{ amount: 84000, state: "revealed" }}
    >
      <div className="space-y-6">
        <PageHeader
          eyebrow="Payments / Runs"
          title="March run"
          description={`${payments.length} ${payments.length === 1 ? "payment" : "payments"}`}
        />
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <AvatarPerson initials={payment.initials} size={26} />
                <span className="truncate text-ui font-medium text-ink">
                  {payment.name}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <AmountDisplay amount={payment.amount} className="text-ui" />
                <WhoCanSee viewerRole={viewerRole} hasAuditor />
              </span>
              <span className="flex items-center gap-1.5">
                <StatusPill status={payment.status} />
                {payment.isTransparent && <TransparentBadge />}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  )
}
