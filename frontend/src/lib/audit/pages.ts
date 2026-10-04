import { isApiError } from "@/lib/api/errors"

// The shape React Query keeps for a cursor-paged list.
export type Pages<T> = { pages: readonly { items: readonly T[] }[] }

export function loadedItems<T>(data: Pages<T> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

export type ListState =
  "loading" | "not-found" | "error" | "empty" | "no-match" | "ready"

// One place decides which of a list's screens shows, so the order cannot drift between lists.
// `companyScoped` marks a list whose `not_found` answer means "not your company": only then is
// it shown as such. Anywhere else a 404 (a missing route, say) is an error that can be retried.
export function listState({
  isPending,
  error,
  loaded,
  shown,
  companyScoped = false,
}: {
  isPending: boolean
  error: unknown
  loaded: number
  shown: number
  companyScoped?: boolean
}): ListState {
  if (isPending) return "loading"
  // A later page failing keeps what is already on screen.
  if (error && loaded === 0) {
    return companyScoped && isCompanyNotFound(error) ? "not-found" : "error"
  }
  if (loaded === 0) return "empty"
  return shown === 0 ? "no-match" : "ready"
}

function isCompanyNotFound(error: unknown) {
  return isApiError(error) && error.status === 404 && error.code === "not_found"
}

// Whether "Try again" can help: not for an answer that says this account may not ask.
export function canRetry(error: unknown) {
  return !(isApiError(error) && (error.status === 401 || error.status === 403))
}

// Filters narrow only what is loaded, so with more pages to come the screen says so.
export function showFilterNote(filtersOn: boolean, hasNextPage: boolean) {
  return filtersOn && hasNextPage
}

// What a screen reader hears when "Load more" adds rows; nothing when the count did not grow.
export function loadedMessage(before: number, after: number) {
  return after > before ? `Loaded ${after - before} more` : ""
}
