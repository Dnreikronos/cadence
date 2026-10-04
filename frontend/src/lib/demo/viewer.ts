import type { Role } from "@/lib/auth/guard"
import type { CurrentViewer } from "@/lib/auth/viewer"

export const DEMO_COOKIE = "cadence-demo-role"

export const demoRoles: readonly Role[] = ["admin", "recipient", "auditor"]

const emails: Record<Role, string> = {
  admin: "ana@solaris.test",
  recipient: "bruno@solaris.test",
  auditor: "carla@acme-audit.test",
}

// Anything but a known role, including a forged cookie value, is no role.
export function parseDemoRole(value: unknown): Role | null {
  return demoRoles.find((role) => role === value) ?? null
}

export function demoViewer(role: Role): CurrentViewer {
  return {
    email: emails[role],
    membership: { role, company: { name: "Solaris" } },
  }
}
