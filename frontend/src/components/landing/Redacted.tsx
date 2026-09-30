import { cn } from "@/lib/utils"

export function Redacted({
  children,
  isRevealed,
  delay = 0,
  className,
}: {
  children: string
  isRevealed: boolean
  delay?: number
  className?: string
}) {
  return (
    <span className={cn("relative inline-block", className)}>
      <span
        aria-hidden={!isRevealed}
        className={cn(
          "inline-block transition-[filter,opacity] duration-500 ease-[var(--ease-out)]",
          isRevealed ? "opacity-100 blur-none" : "opacity-55 blur-[0.3em] select-none",
        )}
        style={{ transitionDelay: `${delay}ms` }}
      >
        {children}
      </span>
      {!isRevealed && <span className="sr-only">Encrypted amount</span>}
    </span>
  )
}
