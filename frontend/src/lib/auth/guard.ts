export type Role = "admin" | "recipient" | "auditor";

export type Decision = { kind: "next" } | { kind: "redirect"; to: string };

export type Viewer = { signedIn: boolean; roles: readonly Role[] };

const areas: Record<string, Role> = {
  "/company": "admin",
  "/me": "recipient",
  "/audit": "auditor",
};

export function requiredRole(pathname: string): Role | null {
  for (const [prefix, role] of Object.entries(areas)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return role;
  }
  return null;
}

export function guard(pathname: string, viewer: Viewer): Decision {
  const role = requiredRole(pathname);
  if (!role) return { kind: "next" };
  if (!viewer.signedIn) {
    return { kind: "redirect", to: `/sign-in?next=${encodeURIComponent(pathname)}` };
  }
  // The home page will route by membership (#76); until then it is a neutral landing.
  if (!viewer.roles.includes(role)) return { kind: "redirect", to: "/" };
  return { kind: "next" };
}
