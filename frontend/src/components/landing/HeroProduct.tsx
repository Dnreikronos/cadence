"use client"

import { useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronsUpDown,
  Globe,
  LoaderCircle,
  Lock,
  ReceiptText,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { AvatarPerson } from "./AvatarPerson"
import { DemoCursor } from "./DemoCursor"
import { formatUsd, payments } from "./landing-data"
import { Redacted } from "./Redacted"
import { useInView, useSequence } from "./use-sequence"

// idle, glide to Approve, press, sealing, glide to Bruno, hold
const durations = [900, 1000, 260, 2600, 1100, 4200]
const sealEvery = 420
const total = payments.reduce((sum, payment) => sum + payment.amount, 0)
const treasury = 84000

export function HeroProduct() {
  const stageRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(stageRef)
  const { phase, isReduced } = useSequence(durations, { isActive: isInView, isLooping: true })
  const sealedCount = useSealedCount(phase >= 3, isReduced)
  const isDone = sealedCount === payments.length

  const cursorTarget = { 1: "approve", 2: "approve", 3: "approve", 4: "bruno", 5: "bruno" }[phase] ?? null

  return (
    <div ref={stageRef} className="relative">
      <div className="overflow-hidden rounded-[18px] border border-line bg-surface shadow-frame">
        <BarTop />
        <div className="grid lg:grid-cols-[208px_1fr]">
          <Sidebar balance={isDone ? treasury - total : treasury} />
          <div className="grid min-w-0 xl:grid-cols-[1fr_300px]">
            <main className="min-w-0 p-4 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="font-mono text-[11px] text-ink-muted">Payments / Runs</p>
                  <h3 className="mt-1 text-title text-ink">March run</h3>
                  <p className="mt-1 text-ui text-ink-muted">
                    {payments.length} payments · {formatUsd(total)} · one approval
                  </p>
                </div>
                <ButtonApprove state={isDone ? "done" : phase >= 3 ? "busy" : "idle"} isPressed={phase === 2} />
              </div>

              <div className="mt-6 overflow-hidden rounded-xl border border-line">
                <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-line bg-canvas/60 px-4 py-2.5 text-label tracking-[0.08em] text-ink-muted uppercase sm:grid-cols-[1.4fr_0.8fr_1fr_0.9fr]">
                  <span>Recipient</span>
                  <span className="hidden sm:block">Type</span>
                  <span className="text-right sm:text-left">Amount</span>
                  <span className="hidden sm:block">Status</span>
                </div>
                <ul>
                  {payments.map((payment, index) => {
                    const state = index < sealedCount ? "sealed" : index === sealedCount && phase >= 3 ? "sealing" : "ready"
                    return (
                      <li
                        key={payment.id}
                        data-cursor={payment.id === "bruno" ? "bruno" : undefined}
                        className={cn(
                          "grid grid-cols-[1fr_auto] items-center gap-4 border-b border-line px-4 py-3 transition-colors duration-300 last:border-0 sm:grid-cols-[1.4fr_0.8fr_1fr_0.9fr]",
                          payment.id === "bruno" && phase >= 4 && "bg-canvas/70",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <AvatarPerson initials={payment.initials} size={26} />
                          <span className="truncate text-[13.5px] font-medium text-ink">{payment.name}</span>
                        </span>
                        <span className="hidden text-ui text-ink-muted sm:block">{payment.kind}</span>
                        <span className="flex items-center justify-end gap-1.5 font-mono text-ui text-ink tabular-nums sm:justify-start">
                          {formatUsd(payment.amount)}
                          <Lock
                            className={cn(
                              "size-3 text-ink-muted transition-[opacity,scale] duration-300 ease-[var(--ease-out)]",
                              state === "sealed" ? "scale-100 opacity-100" : "scale-50 opacity-0",
                            )}
                          />
                        </span>
                        <span className="hidden sm:block">
                          <ChipStatus state={state} />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
              <p className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-muted">
                <ShieldCheck className="size-3.5" strokeWidth={1.75} />
                Readable by each recipient, Solaris and Carla Reis (auditor).
              </p>
            </main>
            <PanelPublic sealedCount={sealedCount} />
          </div>
        </div>
      </div>
      {!isReduced && <DemoCursor stage={stageRef} target={cursorTarget} isPressed={phase === 2} />}
    </div>
  )
}

function useSealedCount(isSealing: boolean, isReduced: boolean) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (isReduced) return setCount(payments.length)
    if (!isSealing) return setCount(0)
    const timer = setInterval(() => setCount((current) => Math.min(current + 1, payments.length)), sealEvery)
    return () => clearInterval(timer)
  }, [isSealing, isReduced])
  return count
}

function BarTop() {
  return (
    <div className="flex h-11 items-center justify-between gap-4 border-b border-line px-4">
      <span className="flex items-center gap-2 text-ui text-ink">
        <span className="grid size-5 place-items-center rounded-md bg-ink text-[10px] font-semibold text-glow">S</span>
        Solaris
        <ChevronsUpDown className="size-3.5 text-ink-muted" />
      </span>
      <span className="hidden h-7 w-64 items-center gap-2 rounded-lg border border-line bg-canvas/50 px-2.5 text-caption text-ink-muted md:flex">
        <Search className="size-3.5" /> Search payments
        <kbd className="ml-auto rounded border border-line bg-surface px-1 font-mono text-[10px]">⌘K</kbd>
      </span>
      <AvatarPerson initials="AL" size={24} />
    </div>
  )
}

function Sidebar({ balance }: { balance: number }) {
  return (
    <aside className="hidden flex-col justify-between border-r border-line bg-canvas/40 p-3 lg:flex">
      <nav className="space-y-0.5">
        {nav.map((item) => (
          <span
            key={item.label}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui",
              item.isActive ? "bg-surface text-ink shadow-raise ring-1 ring-line" : "text-ink-muted",
            )}
          >
            <item.icon className="size-4" strokeWidth={1.75} />
            {item.label}
          </span>
        ))}
      </nav>
      <div className="mt-10 rounded-xl border border-line bg-surface p-3">
        <p className="flex items-center gap-1.5 text-label text-ink-muted">
          <Lock className="size-3" /> Private balance
        </p>
        <p key={balance} className="mt-1.5 animate-[fade-in_400ms_var(--ease-out)] font-mono text-[14px] text-ink tabular-nums">
          {formatUsd(balance)}
        </p>
        <p className="mt-1 text-[11px] text-ink-muted">Only Solaris and Carla can read this.</p>
      </div>
    </aside>
  )
}

function ButtonApprove({ state, isPressed }: { state: "idle" | "busy" | "done"; isPressed: boolean }) {
  return (
    <span
      data-cursor="approve"
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full px-4 text-ui font-medium transition-[background-color,color,transform] duration-200 ease-[var(--ease-out)]",
        state === "done" ? "bg-glow text-ink" : "bg-ink text-white",
        isPressed && "scale-[0.96]",
      )}
    >
      <span className="relative grid size-3.5 place-items-center">
        <Send className={cn("absolute size-3.5 transition-[opacity,filter,scale] duration-200", state === "idle" ? "opacity-100" : "scale-75 opacity-0 blur-[2px]")} />
        <LoaderCircle className={cn("absolute size-3.5 animate-spin transition-opacity duration-200", state === "busy" ? "opacity-100" : "opacity-0")} />
        <Check className={cn("absolute size-3.5 transition-[opacity,filter,scale] duration-200", state === "done" ? "opacity-100" : "scale-75 opacity-0 blur-[2px]")} />
      </span>
      <span key={state} className="animate-[fade-in_200ms_var(--ease-out)]">
        {{ idle: "Approve run", busy: "Sealing payments", done: "Run approved" }[state]}
      </span>
    </span>
  )
}

function ChipStatus({ state }: { state: "ready" | "sealing" | "sealed" }) {
  const chip = {
    ready: { label: "Ready", className: "border-line text-ink-muted", dot: "bg-ink/25" },
    sealing: { label: "Encrypting", className: "border-uv/40 text-ink", dot: "bg-uv animate-pulse" },
    sealed: { label: "Sealed", className: "border-success-border bg-success-bg text-success-fg", dot: "bg-success-dot" },
  }[state]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors duration-300", chip.className)}>
      <span className={cn("size-1.5 rounded-full", chip.dot)} />
      <span key={state} className="animate-[fade-in_200ms_var(--ease-out)]">
        {chip.label}
      </span>
    </span>
  )
}

function PanelPublic({ sealedCount }: { sealedCount: number }) {
  const landed = payments.slice(0, sealedCount).reverse()
  return (
    <aside className="border-t border-line bg-ink p-4 text-white sm:p-5 xl:border-t-0 xl:border-l">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-ui font-medium">
          <Globe className="size-3.5 text-white/60" strokeWidth={1.75} /> Public view
        </p>
        <span className="text-label text-white/40">what the chain shows</span>
      </div>
      <p className="mt-1 text-caption leading-[1.5] text-white/45">Any explorer or RPC sees this, and nothing more.</p>
      <ul className="mt-4 space-y-2">
        {landed.map((payment) => (
          <li
            key={payment.id}
            className="animate-[fade-in_450ms_var(--ease-out)] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 font-mono text-[11.5px]"
          >
            <div className="flex items-center justify-between text-white/45">
              <span>ConfidentialTransfer</span>
              <span>just now</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="text-white/75">4Nd1…mB7z → {payment.cipher.slice(0, 4)}…{payment.cipher.slice(-4)}</span>
              <Redacted isRevealed={false} className="text-ui text-white">
                {formatUsd(payment.amount)}
              </Redacted>
            </div>
          </li>
        ))}
        {landed.length === 0 && (
          <li className="rounded-lg border border-dashed border-white/15 px-3 py-6 text-center font-mono text-[11.5px] text-white/35">
            Waiting for the run
          </li>
        )}
      </ul>
    </aside>
  )
}

const nav: { label: string; icon: LucideIcon; isActive?: boolean }[] = [
  { label: "Payments", icon: Send, isActive: true },
  { label: "People", icon: Users },
  { label: "Auditors", icon: ShieldCheck },
  { label: "Receipts", icon: ReceiptText },
  { label: "Settings", icon: Settings2 },
]
