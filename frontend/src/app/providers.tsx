"use client"

import { QueryClientProvider } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Toaster } from "sonner"
import { makeQueryClient } from "@/lib/queries/client"
import { pruneEvidence } from "@/lib/submissions"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient())
  // Saved records too old to be of use go once per page load (`pruneEvidence`).
  useEffect(() => void pruneEvidence(), [])
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors />
    </QueryClientProvider>
  )
}
