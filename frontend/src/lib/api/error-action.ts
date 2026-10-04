import { cleanSearch } from "@/lib/auth/guard"
import { isApiError, messageFor } from "./errors"

// What a data screen offers next to an error from the service.
export type ErrorAction = "sign-in" | "retry" | "none"

// The session is gone: asking again would answer the same, so the way forward is to
// sign in.
export function isSignedOut(error: unknown) {
  return (
    isApiError(error) &&
    (error.code === "authentication_required" || error.status === 401)
  )
}

// A 401 gets a sign-in link, an error that may pass (a busy service, a timeout, a
// network drop, a 500 whose copy says to try again) gets "Try again", and one that would
// answer the same again (a forbidden role, a bad request) gets neither, so a button
// never promises what it cannot do.
export function errorActionFor(error: unknown): ErrorAction {
  if (isSignedOut(error)) return "sign-in"
  if (!isApiError(error) || error.isRetryable || error.status >= 500) {
    return "retry"
  }
  return "none"
}

// A sentence that sends the reader to a button that is not there.
const retryAdvice = /try again/i

// What an error screen says. The error's own copy decides, so a 429 never reads "check
// your connection". A screen can word a code its own way (`describe`, like the run
// screens' copy), say something only a dropped connection or an error that is not the
// service's (a timeout) calls for (`networkDescription`), and add what is still true
// (`context`, like "Your people are shown below."). When no action is offered the text
// never says to try again.
export function errorDescription(
  error: unknown,
  options: {
    describe?: (error: unknown) => string
    networkDescription?: string
    context?: string
  } = {},
): string {
  const { describe = messageFor, networkDescription, context } = options
  const network = !isApiError(error) || error.code === "network_error"
  let text =
    network && networkDescription ? networkDescription : describe(error)
  if (errorActionFor(error) === "none") {
    text =
      text
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !retryAdvice.test(sentence))
        .join(" ") || "Something went wrong."
  }
  return context ? `${text} ${context}` : text
}

// Back to the page the person was on once they have signed in. Same shape as the
// middleware's redirect, and `safeNext` there keeps it on this site.
export function signInHref(pathname: string, search = "") {
  return `/sign-in?next=${encodeURIComponent(pathname + cleanSearch(search))}`
}
