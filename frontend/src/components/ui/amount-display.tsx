import { formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"

export type AmountState = "revealed" | "hidden" | "loading"

// Stands in for an amount the viewer can't or can't yet read: it only gives the shape its
// width (it is never visible), so the real figure never reaches the DOM and a figure that
// arrives does not move what is around it.
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
  const shown = state === "revealed" && amount !== undefined
  return (
    <span
      aria-busy={state === "loading" || undefined}
      className={cn(
        "relative inline-block overflow-hidden font-mono text-ink tabular-nums",
        state === "loading" && "rounded-md",
        className,
      )}
    >
      {/* Not the text, blurred and faded: text at that contrast fails WCAG's minimum, and a
          shape says "not here yet" as well. The text below is only there for the width. */}
      <span
        aria-hidden={!shown || undefined}
        className={cn(!shown && "invisible")}
      >
        {shown ? formatUsd(amount) : placeholder}
      </span>
      {!shown && (
        <span
          aria-hidden
          className="absolute inset-x-0 inset-y-[0.2em] rounded-[0.2em] bg-ink/15 blur-[0.04em]"
        />
      )}
      {state === "loading" && (
        <span
          aria-hidden
          className="absolute inset-0 animate-[shimmer_1.4s_var(--ease-in-out)_infinite] bg-linear-to-r from-transparent via-uv/35 to-transparent motion-reduce:hidden"
        />
      )}
      {state === "hidden" && <span className="sr-only">Encrypted amount</span>}
      {state === "loading" && (
        <span className="sr-only">Decrypting amount</span>
      )}
    </span>
  )
}
