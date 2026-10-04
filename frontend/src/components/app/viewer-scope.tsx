"use client"

import { createContext, useContext } from "react"
import type { ViewerScope } from "@/lib/queries/keys"

const ViewerScopeContext = createContext<ViewerScope | null>(null)

// Who the signed-in shell belongs to, for the screens under it whose cached answers are
// per viewer (the account status, like the balances).
export function ViewerScopeProvider({
  viewer,
  children,
}: {
  viewer: ViewerScope
  children: React.ReactNode
}) {
  return <ViewerScopeContext value={viewer}>{children}</ViewerScopeContext>
}

export function useViewerScope(): ViewerScope {
  const viewer = useContext(ViewerScopeContext)
  if (!viewer) {
    throw new Error("useViewerScope must be used inside a signed-in shell")
  }
  return viewer
}
