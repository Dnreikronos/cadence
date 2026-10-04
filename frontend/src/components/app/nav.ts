import {
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  ReceiptText,
  ScrollText,
  Send,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import type { Role } from "@/lib/auth/guard"

// `exact` marks an area root, which must not light up on its subpages.
export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  exact?: boolean
}

export const navByRole: Record<Role, { items: NavItem[]; action?: NavItem }> = {
  admin: {
    items: [
      { label: "Payments", href: "/company", icon: Send, exact: true },
      { label: "People", href: "/company/people", icon: Users },
      { label: "Auditors", href: "/company/auditors", icon: ShieldCheck },
      { label: "Receipts", href: "/company/receipts", icon: ReceiptText },
    ],
    action: {
      label: "Deposit",
      href: "/company/deposit",
      icon: ArrowDownToLine,
    },
  },
  recipient: {
    items: [
      { label: "Balance", href: "/me", icon: Wallet, exact: true },
      { label: "History", href: "/me/history", icon: History },
      { label: "Withdraw", href: "/me/withdraw", icon: ArrowUpFromLine },
    ],
  },
  auditor: {
    items: [
      { label: "Payments", href: "/audit", icon: Send, exact: true },
      { label: "Access log", href: "/audit/access-log", icon: ScrollText },
    ],
  },
}

export const roleLabels: Record<Role, string> = {
  admin: "Admin",
  recipient: "Recipient",
  auditor: "Auditor",
}

// Where "back" goes from a page that is not there: the role's own home.
export const homeLinks: Record<Role, { href: string; label: string }> = {
  admin: { href: "/company", label: "Back to payments" },
  recipient: { href: "/me", label: "Back to your balance" },
  auditor: { href: "/audit", label: "Back to payments" },
}

export function isActive(item: NavItem, pathname: string) {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
