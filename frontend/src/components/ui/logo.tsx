import { cn } from "@/lib/utils"

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 1.75a8.25 8.25 0 0 0 0 16.5Z" fill="currentColor" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display flex items-center gap-2 text-[21px] font-semibold tracking-[-0.04em] text-ink", className)}>
      <LogoMark className="size-[18px]" />
      cadence
    </span>
  )
}
