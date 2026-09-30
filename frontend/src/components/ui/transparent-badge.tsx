import { Eye } from "lucide-react"
import { cn } from "@/lib/utils"

// A payment sent as an ordinary transfer, so its amount is public. Independent of StatusPill.
export function TransparentBadge({ className }: { className?: string }) {
  return (
    <span
      title="Sent as an ordinary transfer. The amount is public on-chain."
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[11.5px] whitespace-nowrap text-warning-fg",
        className,
      )}
    >
      <Eye aria-hidden className="size-3" />
      Transparent
    </span>
  )
}
