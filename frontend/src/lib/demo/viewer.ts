import type { Role } from "@/lib/auth/guard"
import type { CurrentViewer } from "@/lib/auth/viewer"

export const DEMO_COOKIE = "cadence-demo-role"

// The company the mock service holds (`COMPANY_ID` in the mock db); a test keeps them equal.
export const DEMO_COMPANY_ID = "c0000000-0000-4000-8000-000000000001"

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
    membership: { role, company: { id: DEMO_COMPANY_ID, name: "Solaris" } },
  }
}
