"use client"

import { QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { Toaster } from "sonner"
import { makeQueryClient } from "@/lib/queries/client"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient())
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors />
    </QueryClientProvider>
  )
}
