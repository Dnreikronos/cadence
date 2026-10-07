import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const tones = {
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  warning: "border-warning-border bg-warning-bg text-warning-fg",
}

// A boxed message: an icon, a title, an optional line and whatever follows (a button).
// It takes no role of its own: the caller says whether it is an alert, or sits it in a
// live region that is already on the page.
export function Notice({
  tone,
  icon: Icon,
  title,
  description,
  role,
  className,
  children,
}: {
  tone: keyof typeof tones
  icon: LucideIcon
  title: string
  description?: string
  role?: "alert"
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      role={role}
      className={cn("flex gap-3 rounded-xl border p-4", tones[tone], className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-ui font-medium">{title}</p>
        {description && <p className="mt-0.5 text-ui/normal">{description}</p>}
        {children}
      </div>
    </div>
  )
}
