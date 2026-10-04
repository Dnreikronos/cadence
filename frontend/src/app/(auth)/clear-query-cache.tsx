"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

// Reaching a sign-in page means nobody is signed in, whatever was cached before: a
// session that expired on this tab must not leave its data for the next person.
export function ClearQueryCache() {
  const queryClient = useQueryClient()
  useEffect(() => {
    queryClient.clear()
  }, [queryClient])
  return null
}
