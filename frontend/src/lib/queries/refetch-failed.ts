type Retryable = { isError: boolean; refetch: () => unknown }

// One "Try again" must clear every error on a screen that reads several things: it asks
// again for each query that failed, and leaves the healthy ones alone. Returns how many
// it retried.
export function refetchFailed(queries: readonly Retryable[]): number {
  let retried = 0
  for (const query of queries) {
    if (!query.isError) continue
    void query.refetch()
    retried += 1
  }
  return retried
}
