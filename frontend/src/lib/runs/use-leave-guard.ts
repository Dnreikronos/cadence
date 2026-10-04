"use client"

import { useEffect } from "react"
import { leavesPage } from "./leave"

const warning =
  "A payment is still being signed or confirmed. If you leave now, the ones not signed yet won't be sent, and you lose track of the ones in flight."

// Asks before the page is left while `active`: closing or reloading the tab (the
// browser's own prompt) and following a link inside the app (a confirm). The browser's
// Back button and `router.push` are not guarded: the App Router gives no hook to cancel
// a client-side navigation, and faking one with history entries breaks Back for
// everyone. The state this protects (signatures held only on screen) is why persisting
// it is a prerequisite for real signing.
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    const onClick = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest("a") : null
      if (!link) return
      const leaving = leavesPage(
        {
          href: link.getAttribute("href"),
          target: link.target,
          download: link.hasAttribute("download"),
          button: event.button,
          modified:
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
          defaultPrevented: event.defaultPrevented,
        },
        window.location.href,
      )
      // Capture phase, before the router sees the click.
      if (leaving && !window.confirm(warning)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    document.addEventListener("click", onClick, true)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      document.removeEventListener("click", onClick, true)
    }
  }, [active])
}
