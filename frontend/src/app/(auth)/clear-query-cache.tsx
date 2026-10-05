"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { finishLeaving } from "@/lib/submissions"

// Reaching a sign-in page means nobody is signed in, whatever was cached before: a
// session that expired on this tab must not leave its data for the next person. It is
// also where a sign-out that has gone through clears what is settled in the saved records.
export function ClearQueryCache() {
  const queryClient = useQueryClient()
  useEffect(() => {
    queryClient.clear()
    finishLeaving()
  }, [queryClient])
  return null
}
