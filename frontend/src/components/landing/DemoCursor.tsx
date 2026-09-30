"use client"

import { useLayoutEffect, useState } from "react"
import { cn } from "@/lib/utils"

/** A scripted pointer that glides to `[data-cursor=target]` inside `stage` and presses when asked. */
export function DemoCursor({
  stage,
  target,
  isPressed,
}: {
  stage: React.RefObject<HTMLElement | null>
  target: string | null
  isPressed: boolean
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  )

  useLayoutEffect(() => {
    const frame = stage.current
    if (!frame || !target) return
    const measure = () => {
      const element = frame.querySelector<HTMLElement>(
        `[data-cursor="${target}"]`,
      )
      if (!element) return
      const box = frame.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      setPosition({
        x: rect.left - box.left + rect.width * 0.62,
        y: rect.top - box.top + rect.height * 0.58,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [stage, target])

  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-40 transition-[transform,opacity] duration-900 ease-in-out",
        target && position ? "opacity-100" : "opacity-0",
      )}
      style={{
        transform: `translate(${position?.x ?? 0}px, ${position?.y ?? 0}px)`,
      }}
    >
      <span
        className={cn(
          "absolute -top-3 -left-3 size-6 rounded-full bg-ink/15 transition-[transform,opacity] duration-300 ease-out",
          isPressed ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
      <svg
        viewBox="0 0 20 20"
        className={cn(
          "relative size-5 drop-shadow-[0_2px_3px_rgba(0,0,0,0.25)] transition-transform duration-150 ease-out",
          isPressed && "scale-[0.86]",
        )}
      >
        <path
          d="M3 2.5 16.5 9.2l-5.9 1.6-2.4 5.7L3 2.5Z"
          fill="#0e0f0c"
          stroke="white"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
