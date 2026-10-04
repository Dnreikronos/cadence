import {
  AmountNotSavedError,
  inviteMessageFor,
  isRetryablePeopleError,
  peopleMessageFor,
} from "./errors"
import type { SavePersonRequest, SavePersonResult } from "./service"

export type ToastCopy = { message: string; description?: string }

// What a finished save says. An edit that moves a person off an address an
// invite went to also says the invite is now useless.
export function saveSuccessCopy(
  result: SavePersonResult,
  request: SavePersonRequest,
): ToastCopy {
  if (result.inviteStale) {
    return {
      message: "Changes saved",
      description:
        "The email changed, so the invite already sent won't work. Send a new one.",
    }
  }
  return {
    message: request.id ? "Changes saved" : `${request.input.name} added`,
  }
}

// Only a new person needs a toast for a failed amount: it is on the list without
// one and the dialog closes on it. An edit keeps its dialog open, which says so.
export function saveWarningCopy(
  error: unknown,
  request: SavePersonRequest,
): string | null {
  if (error instanceof AmountNotSavedError && request.id === undefined) {
    return peopleMessageFor(error)
  }
  return null
}

export function inviteFailureCopy(error: unknown) {
  return {
    message: inviteMessageFor(error),
    retry: isRetryablePeopleError(error),
  }
}
