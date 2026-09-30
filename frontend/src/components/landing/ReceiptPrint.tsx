"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowDown, Check } from "lucide-react"
import { toast } from "sonner"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { AvatarPerson } from "@/components/ui/avatar-person"

gsap.registerPlugin(ScrollTrigger)

export function ReceiptPrint() {
  const frameRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const media = gsap.matchMedia()
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        paperRef.current,
        { yPercent: -78 },
        {
          yPercent: 0,
          ease: "none",
          scrollTrigger: {
            trigger: frameRef.current,
            start: "top 75%",
            end: "bottom 70%",
            scrub: 0.8,
          },
        },
      )
    })
    return () => media.revert()
  }, [])

  return (
    <div ref={frameRef} className="relative mx-auto w-full max-w-105">
      <div className="relative z-10 h-5 rounded-full bg-ink shadow-[0_10px_20px_-8px_rgba(0,0,0,0.5)]">
        <span className="absolute inset-x-6 top-1/2 h-0.75 -translate-y-1/2 rounded-full bg-black/60" />
      </div>
      <div className="-mt-2.5 overflow-hidden px-4 pb-10">
        <div
          ref={paperRef}
          className="perforated bg-surface px-6 pt-8 pb-10 font-mono text-caption text-ink shadow-[0_30px_50px_-30px_rgba(0,0,0,0.35)] [--hole:4px] [--pitch:12px]"
        >
          <p className="text-center text-[11px] tracking-[0.16em] uppercase">
            Cadence · Decryption log
          </p>
          <p className="mt-1 text-center text-[11px] text-ink-muted">
            Solaris · March 2026
          </p>
          <Rule />
          {entries.map((entry) => (
            <div key={entry.time + entry.who + entry.scope} className="py-3">
              <div className="flex items-center justify-between text-ink-muted">
                <span>{entry.time}</span>
                <span>key {entry.key}</span>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <AvatarPerson initials={entry.initials} size={24} />
                <span className="font-medium">{entry.who}</span>
                <span className="text-ink-muted">· {entry.role}</span>
              </div>
              <div className="mt-1.5 flex justify-between gap-4">
                <span>{entry.reason}</span>
                <span className="text-right text-ink-muted">{entry.scope}</span>
              </div>
              <Rule />
            </div>
          ))}
          <div className="flex justify-between pt-2 font-medium">
            <span>Reads this month</span>
            <span>{entries.length}</span>
          </div>
          <div className="flex justify-between text-ink-muted">
            <span>Unlogged reads</span>
            <span>0</span>
          </div>
          <CodeDots />
          <p className="mt-2 text-center text-[10px] tracking-[0.2em] text-ink-muted">
            0031 · 4ND1 · MB7Z
          </p>
        </div>
      </div>
      <div className="flex justify-center">
        <ButtonExport />
      </div>
    </div>
  )
}

function ButtonExport() {
  const [state, setState] = useState<"idle" | "printing" | "done">("idle")

  function exportSample() {
    if (state !== "idle") return
    setState("printing")
    setTimeout(() => {
      setState("done")
      toast("Sample export", {
        description: "Sign in as an auditor to export your own month.",
      })
    }, 700)
    setTimeout(() => setState("idle"), 2600)
  }

  const label = {
    idle: "Export March as CSV",
    printing: "Printing…",
    done: "Exported",
  }[state]

  return (
    <button
      type="button"
      onClick={exportSample}
      className="group/btn inline-flex h-10 items-center gap-2.5 rounded-full border border-line bg-surface pr-4 pl-3 text-sm font-medium text-ink transition-[transform,border-color] duration-150 ease-out hover:border-ink/25 active:scale-[0.97]"
    >
      <span className="relative grid size-5 place-items-center overflow-hidden">
        <ArrowDown
          className={`absolute size-4 transition-[translate,opacity] duration-300 ease-out ${state === "idle" ? "translate-y-0 opacity-100 group-hover/btn:translate-y-0.5" : "translate-y-4 opacity-0"}`}
        />
        <Check
          className={`absolute size-4 text-emerald-600 transition-[scale,opacity] duration-200 ease-out ${state === "done" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
        />
        <span
          className={`absolute bottom-0 h-px w-3.5 bg-current transition-opacity duration-200 ${state === "done" ? "opacity-0" : "opacity-100"}`}
        />
      </span>
      <span key={state} className="animate-[fade-in_200ms_var(--ease-out)]">
        {label}
      </span>
    </button>
  )
}

function CodeDots() {
  return (
    <span
      aria-hidden
      className="mx-auto mt-6 grid w-fit grid-cols-[repeat(21,6px)] gap-0.5"
    >
      {Array.from({ length: 21 * 5 }, (_, index) => (
        <span
          key={index}
          className={`size-1.5 ${(index * 7919) % 11 < 5 ? "bg-ink" : "bg-transparent"}`}
        />
      ))}
    </span>
  )
}

function Rule() {
  return <div className="mt-3 border-t border-dashed border-ink/25" />
}

const entries = [
  {
    time: "31 MAR 14:02",
    key: "a4…9f",
    who: "Carla Reis",
    role: "Auditor",
    initials: "CR",
    reason: "Monthly close",
    scope: "23 payments",
  },
  {
    time: "31 MAR 09:15",
    key: "c1…07",
    who: "Proof service",
    role: "Cadence",
    initials: "C",
    reason: "Transfer proof",
    scope: "Bruno Costa",
  },
  {
    time: "31 MAR 09:15",
    key: "c1…07",
    who: "Proof service",
    role: "Cadence",
    initials: "C",
    reason: "Transfer proof",
    scope: "Northwind Audit",
  },
  {
    time: "28 MAR 17:40",
    key: "77…e2",
    who: "Ana Lima",
    role: "Admin",
    initials: "AL",
    reason: "Run review",
    scope: "March draft",
  },
]
