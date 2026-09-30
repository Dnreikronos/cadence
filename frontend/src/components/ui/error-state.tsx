"use client"

import { CircleAlert, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants } from "./button"

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  className,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div role="alert" className={cn("flex gap-3 rounded-xl border border-danger-border bg-danger-bg p-4 text-danger-fg", className)}>
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-ui font-medium">{title}</p>
        {description && <p className="mt-0.5 text-ui leading-[1.5]">{description}</p>}
        {onRetry && (
          <button type="button" onClick={onRetry} className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3" })}>
            <RotateCw className="size-3.5" /> Try again
          </button>
        )}
      </div>
    </div>
  )
}
