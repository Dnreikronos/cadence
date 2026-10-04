// The shape React Query keeps for a cursor-paged list.
export type Pages<T> = { pages: readonly { items: readonly T[] }[] }

export function loadedItems<T>(data: Pages<T> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

export type ListState =
  "loading" | "not-found" | "error" | "empty" | "no-match" | "ready"

// One place decides which of a list's screens shows, so the order cannot drift between lists.
export function listState({
  isPending,
  error,
  loaded,
  shown,
}: {
  isPending: boolean
  error: unknown
  loaded: number
  shown: number
}): ListState {
  if (isPending) return "loading"
  // A later page failing keeps what is already on screen.
  if (error && loaded === 0) return isNotFound(error) ? "not-found" : "error"
  if (loaded === 0) return "empty"
  return shown === 0 ? "no-match" : "ready"
}

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  )
}
