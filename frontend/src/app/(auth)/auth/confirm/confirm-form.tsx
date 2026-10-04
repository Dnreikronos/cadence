"use client"

import { useEffect, useState } from "react"
import { buttonVariants } from "@/components/ui/button"

// A native POST (the verify route redirects), made once: a second click would send the
// spent token again and answer "link expired" to someone who has just been signed in.
export function ConfirmForm({
  describedBy,
  children,
}: {
  describedBy: string
  children: React.ReactNode
}) {
  const [sent, setSent] = useState(false)
  // Coming back with the browser's back button restores this page from its cache, mid-state.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setSent(false)
    }
    window.addEventListener("pageshow", reset)
    return () => window.removeEventListener("pageshow", reset)
  }, [])

  return (
    <form
      method="post"
      action="/auth/confirm/verify"
      onSubmit={(event) => {
        if (sent) return event.preventDefault()
        setSent(true)
      }}
      className="mt-5 space-y-3"
    >
      {children}
      <button
        type="submit"
        autoFocus
        aria-disabled={sent}
        aria-describedby={describedBy}
        className={buttonVariants({
          className: "w-full aria-disabled:opacity-50",
        })}
      >
        {sent ? "Continuing…" : "Continue"}
      </button>
    </form>
  )
}
