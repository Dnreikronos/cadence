"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Dialog } from "@base-ui/react/dialog"
import { Lock, Menu, X } from "lucide-react"
import type { Role } from "@/lib/auth/guard"
import { cn } from "@/lib/utils"
import { AmountDisplay, type AmountState } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { isActive, navByRole, roleLabels } from "./nav"

export type ShellCompany = { name: string }
export type ShellBalance = { amount?: number; state: AmountState }

export function AppShell({
  role,
  company,
  balance,
  children,
}: {
  role: Role
  company: ShellCompany
  balance?: ShellBalance
  children: React.ReactNode
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  useCloseAtDesktop(isDrawerOpen, setIsDrawerOpen)
  // Auditors read company money; they hold no balance of their own.
  const shownBalance = role === "auditor" ? undefined : balance

  return (
    <div className="min-h-svh bg-canvas">
      <BarTop
        role={role}
        company={company}
        onMenu={() => setIsDrawerOpen(true)}
      />
      <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] border-r border-line bg-surface-subtle lg:block">
          <Sidebar role={role} balance={shownBalance} />
        </aside>
        <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          {children}
        </main>
      </div>

      <Dialog.Root open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/30 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 lg:hidden" />
          <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-70 max-w-[85vw] flex-col border-r border-line bg-surface-subtle shadow-card transition-transform duration-300 ease-out outline-none data-ending-style:-translate-x-full data-starting-style:-translate-x-full lg:hidden">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
              <Dialog.Title className="text-ui font-medium text-ink">
                {company.name}
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink"
              >
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <Sidebar
              role={role}
              balance={shownBalance}
              onNavigate={() => setIsDrawerOpen(false)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

// The drawer is hidden from lg up; left open, it would keep trapping focus invisibly.
function useCloseAtDesktop(
  isOpen: boolean,
  setIsOpen: (isOpen: boolean) => void,
) {
  useEffect(() => {
    if (!isOpen) return
    const close = () => setIsOpen(false)
    const desktop = window.matchMedia("(min-width: 64rem)")
    if (desktop.matches) return close()
    desktop.addEventListener("change", close)
    return () => desktop.removeEventListener("change", close)
  }, [isOpen, setIsOpen])
}

function BarTop({
  role,
  company,
  onMenu,
}: {
  role: Role
  company: ShellCompany
  onMenu: () => void
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open menu"
        className="-ml-1.5 grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink lg:hidden"
      >
        <Menu className="size-4" />
      </button>
      <span className="flex min-w-0 items-center gap-2 text-ui text-ink">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-md bg-ink text-[11px] font-semibold text-glow"
        >
          {company.name.charAt(0).toUpperCase()}
        </span>
        <span className="truncate font-medium">{company.name}</span>
        <span className="shrink-0 rounded-[4px] border border-line px-1.5 py-0.5 text-label text-ink-muted uppercase">
          {roleLabels[role]}
        </span>
      </span>
    </header>
  )
}

function Sidebar({
  role,
  balance,
  onNavigate,
}: {
  role: Role
  balance?: ShellBalance
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const { items, action } = navByRole[role]

  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-6 overflow-y-auto p-3">
      <nav aria-label="Main" className="space-y-0.5">
        {action && (
          <Link
            href={action.href}
            onClick={onNavigate}
            className={buttonVariants({ className: "mb-3 w-full" })}
          >
            <action.icon className="size-4" /> {action.label}
          </Link>
        )}
        {items.map((item) => {
          const isCurrent = isActive(item, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui transition-colors duration-150",
                isCurrent
                  ? "bg-surface text-ink shadow-raise ring-1 ring-line"
                  : "text-ink-muted hover:bg-surface/60 hover:text-ink",
              )}
            >
              <item.icon className="size-4" strokeWidth={1.75} />
              {item.label}
            </Link>
          )
        })}
      </nav>
      {balance && <CardBalance balance={balance} />}
    </div>
  )
}

function CardBalance({ balance }: { balance: ShellBalance }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <p className="flex items-center gap-1.5 text-label text-ink-muted">
        <Lock className="size-3" /> Private balance
      </p>
      <AmountDisplay
        amount={balance.amount}
        state={balance.state}
        className="mt-1.5 text-[14px]"
      />
      <p className="mt-1 text-[11px] text-ink-muted">
        Sealed on-chain. The public cannot read it.
      </p>
    </div>
  )
}
