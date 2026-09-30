"use client"

import { useRef, useState } from "react"
import { ArrowDown, ArrowDownToLine, ArrowUpFromLine, Check, Globe, Lock, Send, TriangleAlert, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { DemoCursor } from "./DemoCursor"
import { formatUsd, payments } from "./landing-data"
import { Redacted } from "./Redacted"
import { SealGuilloche } from "./SealGuilloche"
import { useInView, useSequence } from "./use-sequence"

type DemoProps = { isActive: boolean; onDone: () => void }

export function StepsDemo() {
  const frameRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(frameRef)
  const [active, setActive] = useState(0)
  const [cycle, setCycle] = useState(0)
  const Demo = steps[active].demo

  function select(index: number) {
    setActive(index)
    setCycle((current) => current + 1)
  }

  return (
    <div ref={frameRef} className="grid border-t border-line lg:grid-cols-12">
      <ol className="border-line lg:col-span-4 lg:border-r">
        {steps.map((step, index) => {
          const isCurrent = index === active
          return (
            <li key={step.title} className="border-b border-line last:border-b-0 max-lg:last:border-b">
              <button
                type="button"
                onClick={() => select(index)}
                aria-current={isCurrent ? "step" : undefined}
                className="group/step relative w-full px-6 py-6 text-left outline-none focus-visible:bg-surface sm:px-10"
              >
                <span className="flex items-center gap-3">
                  <span
                    className={cn(
                      "grid size-8 place-items-center rounded-lg border transition-[background-color,border-color,color] duration-300",
                      isCurrent ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-muted group-hover/step:text-ink",
                    )}
                  >
                    <step.icon className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className={cn("text-lead font-medium transition-colors", isCurrent ? "text-ink" : "text-ink-muted group-hover/step:text-ink")}>
                    {step.title}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-muted">0{index + 1}</span>
                </span>
                <span
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-400 ease-[var(--ease-out)]",
                    isCurrent ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <span className="overflow-hidden">
                    <span className="block pt-3 pl-11 text-[14.5px] leading-[1.6] text-ink-muted">{step.body}</span>
                  </span>
                </span>
                {isCurrent && (
                  <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-line">
                    <span
                      key={cycle}
                      className="block h-full origin-left bg-ink motion-reduce:hidden"
                      style={{
                        animation: `grow ${step.duration}ms linear forwards`,
                        animationPlayState: isInView ? "running" : "paused",
                      }}
                    />
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
      <div className="relative flex min-h-[440px] overflow-hidden bg-[radial-gradient(circle_at_center,var(--color-line)_1px,transparent_1px)] [background-size:18px_18px] lg:col-span-8 lg:min-h-[500px]">
        <div key={`${active}-${cycle}`} className="w-full animate-[fade-in_500ms_var(--ease-out)]">
          <Demo isActive={isInView} onDone={() => select((active + 1) % steps.length)} />
        </div>
      </div>
    </div>
  )
}

const depositDurations = [700, 900, 240, 1500, 2800]
function DemoDeposit({ isActive, onDone }: DemoProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const { phase, isReduced } = useSequence(depositDurations, { isActive, onDone })
  const isWrapped = phase >= 3

  return (
    <div ref={stageRef} className="relative flex h-full flex-col items-center justify-center gap-3 px-5 py-10">
      <div className="w-full max-w-[380px] rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="flex items-center justify-between">
          <span className="text-ui font-medium text-ink">Treasury wallet</span>
          <span className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-label text-ink-muted">
            <Globe className="size-3" /> public
          </span>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <p key={String(isWrapped)} className="animate-[fade-in_400ms_var(--ease-out)] text-amount text-ink tabular-nums">
            {isWrapped ? "$0.00" : "$84,000.00"} <span className="text-caption text-ink-muted">USDC</span>
          </p>
          <span
            data-cursor="wrap"
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-[transform,background-color,color] duration-200",
              isWrapped ? "bg-canvas text-ink-muted" : "bg-ink text-white",
              phase === 2 && "scale-[0.95]",
            )}
          >
            {isWrapped ? <Check className="size-3.5" /> : <ArrowDownToLine className="size-3.5" />}
            {isWrapped ? "Wrapped" : "Wrap to private"}
          </span>
        </div>
      </div>

      <span className={cn("grid size-7 place-items-center rounded-full border border-line bg-surface text-ink-muted transition-[opacity,translate] duration-500 ease-[var(--ease-out)]", isWrapped ? "opacity-100" : "-translate-y-1 opacity-0")}>
        <ArrowDown className="size-3.5" />
      </span>

      <div
        className={cn(
          "relative w-full max-w-[380px] overflow-hidden rounded-2xl bg-ink p-4 text-white shadow-[0_24px_50px_-26px_rgba(0,0,0,0.6)] transition-[opacity,translate,filter] duration-700 ease-[var(--ease-out)]",
          isWrapped ? "opacity-100" : "translate-y-3 opacity-0 blur-[4px]",
        )}
      >
        <SealGuilloche
          rings={7}
          className={cn(
            "absolute -top-16 -right-14 size-48 text-glow/30 transition-[scale,rotate] duration-[900ms] ease-[var(--ease-out)]",
            isWrapped ? "scale-100 rotate-0" : "scale-125 -rotate-45",
          )}
        />
        <div className="relative flex items-center justify-between">
          <span className="text-ui font-medium">Private USDC</span>
          <span className="flex items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 text-label text-white/60">
            <Lock className="size-3" /> sealed · 1:1
          </span>
        </div>
        <dl className="relative mt-4 grid grid-cols-2 gap-3 font-mono text-caption">
          <div>
            <dt className="text-white/45">Solaris sees</dt>
            <dd className="mt-1 text-[16px] tabular-nums">$84,000.00</dd>
          </div>
          <div>
            <dt className="text-white/45">The chain sees</dt>
            <dd className="mt-1 text-[16px] tabular-nums">
              <Redacted isRevealed={!isWrapped && !isReduced} delay={500}>
                $84,000.00
              </Redacted>
            </dd>
          </div>
        </dl>
      </div>
      <p className="mt-2 max-w-[380px] text-center font-mono text-[11px] text-ink-muted">The deposit total is public. After that, balances are sealed.</p>
      {!isReduced && <DemoCursor stage={stageRef} target={phase >= 1 && phase <= 2 ? "wrap" : null} isPressed={phase === 2} />}
    </div>
  )
}

const payDurations = [600, 900, 240, 2900, 2600]
const flightMs = 1300
const flightGap = 240
function DemoPay({ isActive, onDone }: DemoProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const { phase, isReduced } = useSequence(payDurations, { isActive, onDone })
  const isSent = phase >= 3

  return (
    <div ref={stageRef} className="relative flex h-full items-center gap-2 px-4 py-10 sm:gap-4 sm:px-10">
      <div className="relative z-10 w-[132px] shrink-0 overflow-hidden rounded-2xl bg-ink p-3.5 text-white shadow-[0_24px_50px_-26px_rgba(0,0,0,0.6)] sm:w-[170px]">
        <SealGuilloche rings={5} className="absolute -right-10 -bottom-10 size-32 text-glow/25" />
        <p className="relative text-[12.5px] font-medium">Private USDC</p>
        <p className="relative mt-1 font-mono text-[11px] text-white/45">Solaris</p>
        <span
          data-cursor="send"
          className={cn(
            "relative mt-4 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-caption font-medium transition-[transform,background-color,color] duration-200",
            isSent ? "bg-glow text-ink" : "bg-white text-ink",
            phase === 2 && "scale-[0.95]",
          )}
        >
          {isSent ? <Check className="size-3.5" /> : <Send className="size-3.5" />} {isSent ? "Approved" : "Approve"}
        </span>
      </div>

      <div className="relative h-[300px] flex-1">
        <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          {payments.map((payment, index) => (
            <path
              key={payment.id}
              d={`M0 50 C 50 50, 50 ${rowY(index)}, 100 ${rowY(index)}`}
              fill="none"
              stroke="var(--ink)"
              strokeOpacity={isSent ? 0.28 : 0.12}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              className="transition-[stroke-opacity] duration-500"
            />
          ))}
        </svg>
        {isSent &&
          !isReduced &&
          payments.map((payment, index) => (
            <span
              key={payment.id}
              aria-hidden
              className="absolute top-1/2 left-0 z-10 h-0 w-full"
              style={{ animation: `packet-x ${flightMs}ms linear ${index * flightGap}ms both` }}
            >
              <span
                className="absolute top-0 left-0 block"
                style={{ animation: `packet-y-${index} ${flightMs}ms var(--ease-in-out) ${index * flightGap}ms both` }}
              >
                <span className="block -translate-x-1/2 -translate-y-1/2 rounded-full border border-uv/40 bg-surface px-2 py-0.5 text-label whitespace-nowrap text-ink shadow-[0_4px_14px_-4px_var(--uv)]">
                  <span className="inline-block blur-[3px]">{formatUsd(payment.amount)}</span>
                </span>
              </span>
            </span>
          ))}
      </div>

      <ul className="relative z-10 flex h-[300px] w-[150px] shrink-0 flex-col justify-between sm:w-[190px]">
        {payments.map((payment, index) => {
          return (
            <li key={payment.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 shadow-[0_8px_20px_-16px_rgba(20,20,10,0.4)]">
              <AvatarPerson initials={payment.initials} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-caption font-medium text-ink">{payment.name.split(" ")[0]}</span>
                <span className="block font-mono text-[11px] text-ink tabular-nums">
                  <Redacted isRevealed={isSent} delay={isReduced ? 0 : index * flightGap + flightMs}>
                    {formatUsd(payment.amount)}
                  </Redacted>
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="absolute inset-x-0 bottom-5 text-center font-mono text-[11px] text-ink-muted">Sealed on the wire. Readable on arrival, by the recipient only.</p>
      {!isReduced && <DemoCursor stage={stageRef} target={phase >= 1 && phase <= 2 ? "send" : null} isPressed={phase === 2} />}
    </div>
  )
}

function rowY(index: number) {
  return 8 + index * 21
}

const withdrawDurations = [600, 900, 1300, 1900, 900, 240, 1000, 900, 240, 2800]
function DemoWithdraw({ isActive, onDone }: DemoProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const { phase, isReduced } = useSequence(withdrawDurations, { isActive, onDone })
  const typed = phase < 2 ? "" : phase === 2 ? "4,200.00" : phase < 6 ? "4,200.00" : "1,000.00"
  const hasWarning = phase >= 3 && phase < 6
  const isDone = phase >= 9
  const cursorTarget = { 1: "amount", 2: "amount", 3: "amount", 4: "parts", 5: "parts", 7: "withdraw", 8: "withdraw" }[phase] ?? null

  return (
    <div ref={stageRef} className="relative flex h-full flex-col items-center px-5 pt-10 pb-10 sm:pt-14">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-surface p-5 shadow-card">
        <div className="flex items-center gap-2.5">
          <AvatarPerson initials="BC" size={28} />
          <span className="text-ui font-medium text-ink">Bruno&apos;s balance</span>
          <span className="ml-auto flex items-center gap-1 text-label text-ink-muted">
            <Lock className="size-3" /> only he sees it
          </span>
        </div>
        <p className="mt-3 text-amount text-ink tabular-nums">
          {isDone ? "$3,200.00" : "$4,200.00"} <span className="text-caption text-ink-muted">private USDC</span>
        </p>

        <label className="mt-5 block font-mono text-[11px] text-ink-muted">Withdraw to normal USDC</label>
        <div data-cursor="amount" className={cn("mt-1.5 flex h-11 items-center rounded-xl border px-3 font-mono text-[15px] text-ink transition-colors duration-300", hasWarning ? "border-amber-300" : "border-line")}>
          <span className="text-ink-muted">$</span>
          <span key={typed} className={cn("ml-1", phase === 2 && "animate-[type_1100ms_steps(8)_both] overflow-hidden whitespace-nowrap")}>
            {typed}
          </span>
          {phase >= 1 && phase <= 2 && <span className="ml-px h-4 w-px animate-pulse bg-ink" />}
        </div>

        <div className={cn("grid transition-[grid-template-rows,opacity] duration-400 ease-[var(--ease-out)]", hasWarning ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
          <div className="overflow-hidden">
            <div className="mt-3 flex gap-2.5 rounded-xl border border-warning-border bg-warning-bg p-3 text-[12.5px] leading-[1.5] text-warning-fg">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <p>This matches a payment you received exactly. Withdrawing it in one piece shows the amount.</p>
                <span
                  data-cursor="parts"
                  className={cn("mt-2 inline-flex h-7 items-center rounded-full bg-warning-fg px-3 text-caption font-medium text-warning-bg transition-transform duration-150", phase === 5 && "scale-[0.95]")}
                >
                  Withdraw in parts
                </span>
              </div>
            </div>
          </div>
        </div>

        <span
          data-cursor="withdraw"
          className={cn(
            "mt-4 flex h-10 items-center justify-center gap-2 rounded-full text-ui font-medium transition-[transform,background-color,color] duration-200",
            isDone ? "bg-glow text-ink" : "bg-ink text-white",
            phase === 8 && "scale-[0.97]",
          )}
        >
          {isDone ? <Check className="size-4" /> : <ArrowUpFromLine className="size-4" />}
          {isDone ? "Withdrawn" : "Withdraw"}
        </span>
      </div>
      <p
        className={cn(
          "mt-4 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-[11px] text-ink-muted transition-[opacity,translate,filter] duration-500 ease-[var(--ease-out)]",
          isDone ? "opacity-100" : "translate-y-2 opacity-0 blur-[3px]",
        )}
      >
        <Globe className="size-3" /> On-chain: withdrawal of $1,000.00 is public. The $4,200 stays unlinked.
      </p>
      {!isReduced && <DemoCursor stage={stageRef} target={cursorTarget} isPressed={phase === 5 || phase === 8} />}
    </div>
  )
}

const steps: { title: string; body: string; icon: LucideIcon; demo: (props: DemoProps) => React.ReactNode; duration: number }[] = [
  {
    title: "Deposit",
    body: "Wrap USDC 1:1 into private USDC, backed by a public contract anyone can verify. Only the deposit total is public.",
    icon: ArrowDownToLine,
    demo: DemoDeposit,
    duration: depositDurations.reduce((sum, ms) => sum + ms, 0),
  },
  {
    title: "Pay",
    body: "Approve once for one payment or fifty. Each lands in a single transaction, sealed on the way and readable on arrival.",
    icon: Send,
    demo: DemoPay,
    duration: payDurations.reduce((sum, ms) => sum + ms, 0),
  },
  {
    title: "Withdraw",
    body: "Recipients unwrap when they need to. Cadence warns them before a withdrawal gives an amount away.",
    icon: ArrowUpFromLine,
    demo: DemoWithdraw,
    duration: withdrawDurations.reduce((sum, ms) => sum + ms, 0),
  },
]
