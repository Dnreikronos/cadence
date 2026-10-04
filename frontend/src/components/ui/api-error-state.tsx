"use client"

import { usePathname, useSearchParams } from "next/navigation"
import {
  errorActionFor,
  errorDescription,
  signInHref,
} from "@/lib/api/error-action"
import { ErrorState } from "./error-state"

// `ErrorState` for an error from the service: the action and the words come from the
// error. A 401 gets a "Sign in" link back to this page, an error that may pass gets "Try
// again" (when the screen can retry), and one that would answer the same gets neither
// and is never told to try again (see `errorDescription` for the options).
export function ApiErrorState({
  error,
  title,
  describe,
  networkDescription,
  context,
  onRetry,
  className,
}: {
  error: unknown
  title?: string
  describe?: (error: unknown) => string
  networkDescription?: string
  context?: string
  onRetry?: () => void
  className?: string
}) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const action = errorActionFor(error)
  return (
    <ErrorState
      title={title}
      description={errorDescription(error, {
        describe,
        networkDescription,
        context,
      })}
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
