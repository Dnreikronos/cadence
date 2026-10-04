"use client"

import Link from "next/link"
import { CircleAlert, LogIn, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants } from "./button"

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  signInHref,
  className,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  // For a signed-out error: a link instead of a retry that would fail the same way.
  signInHref?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-3 rounded-xl border border-danger-border bg-danger-bg p-4 text-danger-fg",
        className,
      )}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-ui font-medium">{title}</p>
        {description && <p className="mt-0.5 text-ui/normal">{description}</p>}
        {signInHref && (
          <Link
            href={signInHref}
            className={buttonVariants({
              variant: "secondary",
              size: "sm",
              className: "mt-3",
            })}
          >
            <LogIn className="size-3.5" /> Sign in
          </Link>
        )}
        {!signInHref && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={buttonVariants({
              variant: "secondary",
              size: "sm",
              className: "mt-3",
            })}
          >
            <RotateCw className="size-3.5" /> Try again
          </button>
        )}
      </div>
    </div>
  )
}
