import { isApiError, messageFor } from "@/lib/api/errors"

export class DuplicateEmailError extends Error {
  constructor() {
    super("duplicate_email")
    this.name = "DuplicateEmailError"
  }
}

export class PersonNotFoundError extends Error {
  constructor() {
    super("person_not_found")
    this.name = "PersonNotFoundError"
  }
}

// The people table could not be read or written. It never carries the store's
// own message, which can name tables and columns.
export class PeopleStoreError extends Error {
  constructor() {
    super("people_store_unavailable")
    this.name = "PeopleStoreError"
  }
}

// The person was saved but the amount was not: the list is right, the amount is
// missing or stale.
export class AmountNotSavedError extends Error {
  readonly reason: unknown
  constructor(reason: unknown) {
    super("amount_not_saved")
    this.name = "AmountNotSavedError"
    this.reason = reason
  }
}

const inviteMessages: Record<string, string> = {
  person_already_active: "This person already has an account.",
  person_removed: "This person was removed, so they can't be invited.",
  person_not_found: "This person is no longer on your list.",
}

export function inviteMessageFor(error: unknown) {
  if (isApiError(error)) {
    if (Object.hasOwn(inviteMessages, error.code)) {
      return inviteMessages[error.code]
    }
    // Whatever the budget's code, it is invites that are limited here, not payments.
    if (error.status === 429) {
      return "Too many invites sent. Wait a moment and try again."
    }
  }
  return messageFor(error)
}

export function peopleMessageFor(error: unknown) {
  if (error instanceof DuplicateEmailError) {
    return "Someone with this email is already on your list, or was removed from it."
  }
  if (error instanceof PersonNotFoundError) {
    return "This person is no longer on your list."
  }
  if (error instanceof PeopleStoreError) {
    return "Couldn't reach your people list. Try again."
  }
  if (error instanceof AmountNotSavedError) {
    return `Saved, but the monthly amount wasn't. ${amountMessageFor(error.reason)}`
  }
  return messageFor(error)
}

function amountMessageFor(error: unknown) {
  if (isApiError(error) && error.code === "person_not_found") {
    return "This person is no longer on your list."
  }
  return messageFor(error)
}

// Worth offering a retry: the same request may work in a moment.
export function isRetryablePeopleError(error: unknown) {
  if (error instanceof PeopleStoreError) return true
  // Not an AmountNotSavedError: repeating a create would add the person twice.
  return isApiError(error) && error.isRetryable
}
