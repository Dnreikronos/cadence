import { formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"

export type AmountState = "revealed" | "hidden" | "loading"

// Stands in for an amount the viewer can't or can't yet read, so the real figure never reaches the DOM.
const placeholder = "$0,000.00"

export function AmountDisplay({
  amount,
  state = "revealed",
  className,
}: {
  amount?: number
  state?: AmountState
  className?: string
}) {
  const text = state === "revealed" && amount !== undefined ? formatUsd(amount) : placeholder
  return (
    <span
      aria-busy={state === "loading" || undefined}
      className={cn("relative inline-block overflow-hidden font-mono text-ink tabular-nums", state === "loading" && "rounded-md", className)}
    >
      <span
        aria-hidden={state !== "revealed"}
        className={cn(
          "inline-block transition-[filter,opacity] duration-500 ease-[var(--ease-out)]",
          state === "revealed" ? "opacity-100 blur-none" : "opacity-55 blur-[0.3em] select-none",
        )}
      >
        {text}
      </span>
      {state === "loading" && (
        <span
          aria-hidden
          className="absolute inset-0 animate-[shimmer_1.4s_var(--ease-in-out)_infinite] bg-linear-to-r from-transparent via-uv/35 to-transparent motion-reduce:hidden"
        />
      )}
      {state === "hidden" && <span className="sr-only">Encrypted amount</span>}
      {state === "loading" && <span className="sr-only">Decrypting amount</span>}
    </span>
  )
}
