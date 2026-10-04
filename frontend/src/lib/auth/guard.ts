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

// Next adds `_rsc` (and `__next*` in places) to its own navigations: they mean nothing to
// the person and must not come back after sign-in. The rest of the query string goes into
// `next`, in the address bar and in logs, so guarded routes must never carry a secret in it.
export function cleanSearch(search: string) {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => {
      const key = pair.split("=")[0]
      return pair !== "" && key !== "_rsc" && !key.startsWith("__next")
    })
  return kept.length ? `?${kept.join("&")}` : ""
}

// Pages outside a role's home prefix that still belong to that role.
const rolePages: Record<Role, string[]> = {
  admin: [],
  recipient: ["/activate"],
  auditor: [],
}

export function requiredRole(pathname: string): Role | null {
  for (const [role, prefix] of Object.entries(homes) as [Role, string][]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return role
    // Like a home prefix, so `/activate/` and anything under it are guarded too.
    if (
      rolePages[role].some(
        (p) => pathname === p || pathname.startsWith(`${p}/`),
      )
    ) {
      return role
    }
  }
  return null
}

// `viewer` is the signed-in member's role, or null when signed out: every session has a membership.
// `search` (with its "?") rides along in `next`, so a filtered page survives the sign-in.
export function guard(
  pathname: string,
  viewer: Role | null,
  search = "",
): Decision {
  const role = requiredRole(pathname)
  if (!role) return { kind: "next" }
  if (!viewer) {
    return {
      kind: "redirect",
      to: `/sign-in?next=${encodeURIComponent(pathname + search)}`,
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
