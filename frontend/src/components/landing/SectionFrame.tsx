import { cn } from "@/lib/utils"
import { SplitWords } from "./LandingMotion"

export function SectionFrame({
  id,
  className,
  innerClassName,
  children,
}: {
  id?: string
  className?: string
  innerClassName?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className={cn("border-b border-line", className)}>
      <div className={cn("mx-auto max-w-[1248px] border-x border-line bg-white", innerClassName)}>{children}</div>
    </section>
  )
}

export function SectionHeading({
  index,
  eyebrow,
  title,
  muted,
  aside,
  isDark = false,
}: {
  index: string
  eyebrow: string
  title: string
  muted: string
  aside?: React.ReactNode
  isDark?: boolean
}) {
  return (
    <div className="grid gap-8 px-6 pt-20 pb-12 sm:px-12 sm:pt-28 sm:pb-16 lg:grid-cols-12">
      <div className="lg:col-span-9">
        <p className={cn("flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] uppercase", isDark ? "text-white/45" : "text-ink-muted")}>
          <span className={cn("rounded-[4px] border px-1.5 py-0.5", isDark ? "border-white/15" : "border-line bg-white")}>{index}</span>
          {eyebrow}
        </p>
        <h2 className="mt-6 max-w-[900px] text-[30px] leading-[1.1] font-medium tracking-[-0.03em] sm:text-[40px]">
          <SplitWords className={isDark ? "text-white" : "text-ink"}>{title}</SplitWords>
          <SplitWords className={isDark ? "text-white/45" : "text-ink-muted"}>{muted}</SplitWords>
        </h2>
      </div>
      {aside && <div className="lg:col-span-3 lg:self-end lg:justify-self-end">{aside}</div>}
    </div>
  )
}
