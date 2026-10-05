"use client"

import { useState } from "react"
import { buttonVariants } from "@/components/ui/button"

// The way out of a hold that never resolves: a deliberate release, behind a confirmation
// that says what it risks. It never happens by itself, and nothing about it is logged.
export function ReleaseAction({
  label,
  prompt,
  warning,
  onRelease,
}: {
  // The confirming button, which names what is released.
  label: string
  // The button that opens the confirmation.
  prompt: string
  // What the release risks, in plain words.
  warning: string
  onRelease: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {prompt}
      </button>
    )
  }
  return (
    <div role="group" aria-label={label} className="basis-full space-y-2">
      <p className="text-ui/normal font-medium">{warning}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRelease}
          className={buttonVariants({ size: "sm" })}
        >
          {label}
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Keep it held
        </button>
      </div>
    </div>
  )
}
