import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-12 text-center", className)}>
      <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface text-ink-muted">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <p className="mt-4 text-ui font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-[320px] text-ui leading-[1.5] text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
