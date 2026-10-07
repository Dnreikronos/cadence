"use client"

import Link from "next/link"
import { CircleAlert, LogIn, RotateCw } from "lucide-react"
import { buttonVariants } from "./button"
import { Notice } from "./notice"

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
    <Notice
      role="alert"
      tone="danger"
      icon={CircleAlert}
      title={title}
      description={description}
      className={className}
    >
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
    </Notice>
  )
}
