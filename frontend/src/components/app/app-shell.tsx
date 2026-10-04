"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Dialog } from "@base-ui/react/dialog"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Lock, LogOut, Menu, X } from "lucide-react"
import type { Role } from "@/lib/auth/guard"
import { cn } from "@/lib/utils"
import { AmountDisplay, type AmountState } from "@/components/ui/amount-display"
import { signOut, signOutEverywhere } from "@/lib/auth/actions"
import { buttonVariants } from "@/components/ui/button"
import { SkipLink, mainId } from "@/components/ui/skip-link"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { isActive, navByRole, roleLabels } from "./nav"

export type ShellCompany = { name: string }
// `error` replaces the amount with a note that it could not load; `onRetry` adds a button.
export type ShellBalance = {
  amount?: number
  state: AmountState
  error?: boolean
  onRetry?: () => void
}

export function AppShell({
  role,
  company,
  email,
  balance,
  children,
}: {
  role: Role
  company: ShellCompany
  email: string
  balance?: ShellBalance
  children: React.ReactNode
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  useCloseAtDesktop(isDrawerOpen, setIsDrawerOpen)
  // Auditors read company money; they hold no balance of their own.
  const shownBalance = role === "auditor" ? undefined : balance

  return (
    <div className="min-h-svh bg-canvas">
      <SkipLink />
      <BarTop
        role={role}
        company={company}
        email={email}
        onMenu={() => setIsDrawerOpen(true)}
      />
      <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] print:block">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] border-r border-line bg-surface-subtle lg:block print:hidden">
          <Sidebar role={role} balance={shownBalance} />
        </aside>
        <main
          id={mainId}
          tabIndex={-1}
          className="min-w-0 px-4 py-6 outline-none sm:px-6 lg:px-10 lg:py-8"
        >
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
  email,
  onMenu,
}: {
  role: Role
  company: ShellCompany
  email: string
  onMenu: () => void
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6 print:hidden">
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
      <UserMenu email={email} />
    </header>
  )
}

function UserMenu({ email }: { email: string }) {
  const queryClient = useQueryClient()
  return (
    <Popover>
      <PopoverTrigger className="ml-auto flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui text-ink-muted hover:bg-canvas hover:text-ink">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-surface-subtle text-[11px] font-medium text-ink"
        >
          {email.charAt(0).toUpperCase()}
        </span>
        <span className="hidden max-w-48 truncate sm:inline">{email}</span>
        <ChevronDown aria-hidden className="size-3.5" />
        <span className="sr-only sm:hidden">Account</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <p className="truncate text-label text-ink-muted">Signed in as</p>
        <p className="-mt-1.5 truncate font-medium text-ink">{email}</p>
        {/* Clears the Supabase session; the Turnkey session joins it with the wallet (#77). */}
        {/* The cache is the viewer's data: the next sign-in must not see it. */}
        <div className="border-t border-line pt-2">
          <form
            action={() => {
              queryClient.clear()
              return signOut()
            }}
          >
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-ink-muted hover:bg-canvas hover:text-ink"
            >
              <LogOut className="size-4" strokeWidth={1.75} /> Sign out
            </button>
          </form>
          {/* Ends this account's sessions on every device, for a lost laptop or a shared computer. */}
          <form
            action={() => {
              queryClient.clear()
              return signOutEverywhere()
            }}
          >
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-ink-muted hover:bg-canvas hover:text-ink"
            >
              <LogOut className="size-4" strokeWidth={1.75} /> Sign out of all
              devices
            </button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
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
      {balance.error ? (
        <div role="alert" className="mt-1.5 text-ui/normal text-danger-fg">
          <p>Could not load your balance.</p>
          {balance.onRetry && (
            <button
              type="button"
              onClick={balance.onRetry}
              className="mt-1 underline underline-offset-2 hover:text-ink"
            >
              Try again
            </button>
          )}
        </div>
      ) : (
        <>
          <div aria-live="polite" className="mt-1.5">
            <AmountDisplay
              amount={balance.amount}
              state={balance.state}
              className="text-[14px]"
            />
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">
            Sealed on-chain. The public cannot read it.
          </p>
        </>
      )}
    </div>
  )
}
