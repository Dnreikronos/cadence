type Page<T> = { items: T[]; next_cursor: string | null }

// Reads a paged route to its end. A service that keeps handing out cursors cannot
// loop this forever: it stops at `maxPages` and says so.
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages = 50,
) {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor)
    items.push(...result.items)
    if (!result.next_cursor) return items
    cursor = result.next_cursor
  }
  throw new RangeError(`More than ${maxPages} pages`)
}
