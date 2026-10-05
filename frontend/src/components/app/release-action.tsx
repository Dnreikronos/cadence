"use client"

import { useEffect, useId, useRef, useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { mainId } from "@/components/ui/skip-link"
import { focusIfLost } from "@/lib/restore-focus"

// The way out of a hold that never resolves: a deliberate release, behind a confirmation
// that says what it risks. It never happens by itself, and nothing about it is logged.
//
// Focus never falls to `<body>`: opening the confirmation moves it to the confirmation,
// "Keep it held" returns it to the button that opened it, and a release (which removes
// the notice this lives in) sends it to `afterRelease`, or to the page's main area.
export function ReleaseAction({
  label,
  prompt,
  warning,
  onRelease,
  afterRelease,
}: {
  // The confirming button, which names what is released.
  label: string
  // The button that opens the confirmation.
  prompt: string
  // What the release risks, in plain words.
  warning: string
  // Does the release. It may be refused (the hold changed since the person looked, or
  // another tab is busy with it): it then returns what to tell them, and nothing moves.
  onRelease: () => void | Promise<string | null>
  // Where focus goes once the release has removed the notice: the screen's first action
  // for what is left. Defaults to the main area.
  afterRelease?: () => HTMLElement | null | undefined
}) {
  const [asking, setAsking] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const warningId = useId()
  const opener = useRef<HTMLButtonElement>(null)
  const confirmation = useRef<HTMLDivElement>(null)
  // Set when the confirmation is closed with "Keep it held", so the effect knows to
  // return focus (not on the first render, which has nothing to return).
  const backToOpener = useRef(false)

  useEffect(() => {
    if (asking) {
      confirmation.current?.focus()
    } else if (backToOpener.current) {
      backToOpener.current = false
      opener.current?.focus()
    }
  }, [asking])

  if (!asking) {
    return (
      <button
        ref={opener}
        type="button"
        onClick={() => setAsking(true)}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {prompt}
      </button>
    )
  }
  return (
    <div
      ref={confirmation}
      role="group"
      aria-label={label}
      aria-describedby={warningId}
      // Focusable so the warning is read first, and nothing is one keypress from done.
      tabIndex={-1}
      className="basis-full space-y-2 outline-none"
    >
      <p id={warningId} className="text-ui/normal font-medium">
        {warning}
      </p>
      {refused && (
        <p role="alert" className="text-ui/normal font-medium text-danger-fg">
          {refused}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-disabled={working || undefined}
          onClick={(event) => {
            if (working) return
            const button = event.currentTarget
            setWorking(true)
            void Promise.resolve(onRelease()).then(
              (message) => {
                setWorking(false)
                if (message) {
                  setRefused(message)
                  return
                }
                // The notice (and this button) are gone once the screen has updated.
                setTimeout(() => {
                  focusIfLost(
                    afterRelease?.() ?? document.getElementById(mainId),
                    button,
                  )
                }, 0)
              },
              () => {
                setWorking(false)
                setRefused("Nothing was released. Try again.")
              },
            )
          }}
          className={buttonVariants({ size: "sm" })}
        >
          {label}
        </button>
        <button
          type="button"
          onClick={() => {
            backToOpener.current = true
            setAsking(false)
          }}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Keep it held
        </button>
      </div>
    </div>
  )
}
