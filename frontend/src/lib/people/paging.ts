// PostgREST answers at most 1,000 rows a request (and says nothing when it cuts
// a longer answer), so a list is read in ranges until a short page ends it.
export const PAGE_ROWS = 500

// The most people the screen reads. Beyond it the list says it is partial.
export const MAX_PEOPLE = 2000

export type RowsRead<T> = { rows: T[]; truncated: boolean }

// `fetchRange(from, to)` is inclusive on both ends, like `.range()`. After
// `maxRows` it asks for one more row, so "truncated" is only claimed when there
// is something left out.
export async function readRows<T>(
  fetchRange: (from: number, to: number) => Promise<T[]>,
  maxRows: number,
  pageRows = PAGE_ROWS,
): Promise<RowsRead<T>> {
  const rows: T[] = []
  while (rows.length < maxRows) {
    const want = Math.min(pageRows, maxRows - rows.length)
    const page = await fetchRange(rows.length, rows.length + want - 1)
    rows.push(...page)
    if (page.length < want) return { rows, truncated: false }
  }
  const more = await fetchRange(maxRows, maxRows)
  return { rows, truncated: more.length > 0 }
}
