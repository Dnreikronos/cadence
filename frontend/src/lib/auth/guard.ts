export type Role = "admin" | "recipient" | "auditor"

export type Decision = { kind: "next" } | { kind: "redirect"; to: string }

const homes: Record<Role, string> = {
  admin: "/company",
  recipient: "/me",
  auditor: "/audit",
}

// Where a member lands after sign-in.
export function homeFor(role: Role): string {
  return homes[role]
}

// Pages outside a role's home prefix that still belong to that role.
const rolePages: Record<string, Role> = { "/activate": "recipient" }

export function requiredRole(pathname: string): Role | null {
  if (Object.hasOwn(rolePages, pathname)) return rolePages[pathname]
  for (const [role, prefix] of Object.entries(homes) as [Role, string][]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return role
  }
  return null
}

// `viewer` is the signed-in member's role, or null when signed out: every session has a membership.
export function guard(pathname: string, viewer: Role | null): Decision {
  const role = requiredRole(pathname)
  if (!role) return { kind: "next" }
  if (!viewer) {
    return {
      kind: "redirect",
      to: `/sign-in?next=${encodeURIComponent(pathname)}`,
    }
  }
  if (viewer !== role) return { kind: "redirect", to: homeFor(viewer) }
  return { kind: "next" }
}

// Where to go after sign-in: `next` only when it stays on this site and the role may visit it.
export function safeNext(next: string | null, role: Role): string {
  const home = homeFor(role)
  if (!next?.startsWith("/")) return home
  const base = "http://cadence.invalid"
  const url = new URL(next, base)
  if (url.origin !== base) return home
  if (requiredRole(url.pathname) !== role) return home
  return url.pathname + url.search
}
