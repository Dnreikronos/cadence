"use client"

import { useEffect } from "react"

// Names the tab for a page that cannot do it through `metadata`. A not-found page cannot:
// Next puts its metadata in the first response and puts the layout's title back when the
// page hydrates, and after a navigation on the client the title of the page before would
// stay. So the title is set, and set again whenever something else changes it while this
// page is at this address; leaving it ends that, and the next page names itself.
export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    const full = `${title} · Cadence`
    const path = window.location.pathname
    const apply = () => {
      // Once the address has moved on, the next page's title is not ours to undo.
      if (window.location.pathname !== path) return
      if (document.title !== full) document.title = full
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    return () => observer.disconnect()
  }, [title])
  return null
}
