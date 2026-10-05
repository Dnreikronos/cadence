"use client"

import { useEffect } from "react"

// Asks the browser to confirm before the tab is closed or reloaded while `active`.
// For the moments after a transaction may have been sent and before the person knows
// what became of it: the record of it is kept, but leaving still costs them the answer.
export function useUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [active])
}
