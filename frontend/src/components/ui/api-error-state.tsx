"use client"

import { usePathname, useSearchParams } from "next/navigation"
import { messageFor } from "@/lib/api/errors"
import { errorActionFor, signInHref } from "@/lib/api/error-action"
import { ErrorState } from "./error-state"

// `ErrorState` for an error from the service: the action comes from the error. A 401
// gets a "Sign in" link back to this page, an error that may pass gets "Try again"
// (when the screen can retry), and one that would answer the same gets neither. The
// description is the error's own copy unless the screen has better, except for a 401:
// "check your connection" would contradict the sign-in link next to it.
export function ApiErrorState({
  error,
  title,
  description,
  onRetry,
  className,
}: {
  error: unknown
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const action = errorActionFor(error)
  return (
    <ErrorState
      title={title}
      description={
        action === "sign-in"
          ? messageFor(error)
          : (description ?? messageFor(error))
      }
      onRetry={action === "retry" ? onRetry : undefined}
      signInHref={
        action === "sign-in"
          ? signInHref(pathname, search && `?${search}`)
          : undefined
      }
      className={className}
    />
  )
}
