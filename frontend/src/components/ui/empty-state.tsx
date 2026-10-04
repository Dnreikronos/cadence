import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  titleAs: Title = "p",
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  // The title is the page's heading when the card is the whole page (a 404).
  titleAs?: "p" | "h1" | "h2"
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface text-ink-muted">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <Title className="mt-4 text-ui font-medium text-ink">{title}</Title>
      {description && (
        <p className="mt-1 max-w-[320px] text-ui/normal text-ink-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
