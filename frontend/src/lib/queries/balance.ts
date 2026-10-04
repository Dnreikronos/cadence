"use client"

import { useQuery } from "@tanstack/react-query"
import type { ShellBalance } from "@/components/app/app-shell"
import { api } from "@/lib/api"
import type { Role } from "@/lib/auth/guard"
import { queryKeys, type ViewerScope } from "./keys"
import { shellBalanceOf } from "./shell-balance"

// The private balance in the shell: the company's for an admin, the viewer's own
// for a recipient, cached per viewer. An auditor holds none, so nothing is asked of the service.
export function useShellBalance(
  role: Role,
  viewer: ViewerScope,
): ShellBalance | undefined {
  const query = useQuery({
    queryKey:
      role === "admin"
        ? queryKeys.balance.company(viewer)
        : queryKeys.balance.me(viewer),
    queryFn: ({ signal }) =>
      role === "admin"
        ? api.company.balance({ signal })
        : api.me.balance({ signal }),
    enabled: role !== "auditor",
  })
  return role === "auditor" ? undefined : shellBalanceOf(query)
}
