import type { PersonAmount } from "@/lib/api/schemas"

type Page<T> = { items: T[]; next_cursor: string | null }

export type AmountsRead = {
  byPerson: Record<string, string>
  // The page cap stopped the read: some people may have an amount not listed here.
  truncated: boolean
}

// 100 rows a page, so the default covers 5,000 people: more than the list shows.
export const MAX_AMOUNT_PAGES = 50

// Every amount of the company, by person id, in base units. Follows the cursor to
// the end. A cursor that does not advance would loop forever, so it ends the read
// as complete (the service has nothing more to say); the page cap does not, it
// says so.
export function readAllAmounts(
  fetchPage: (cursor?: string) => Promise<Page<PersonAmount>>,
  maxPages = MAX_AMOUNT_PAGES,
): Promise<AmountsRead> {
  return readAllByPerson(fetchPage, (item) => item.amount, maxPages)
}

// The same walk for any per-person read: one value per person id, null left out.
export async function readAllByPerson<T extends { person_id: string }>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  valueOf: (item: T) => string | null,
  maxPages = MAX_AMOUNT_PAGES,
): Promise<AmountsRead> {
  const byPerson: Record<string, string> = {}
  let cursor: string | undefined
  let more = false
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await fetchPage(cursor)
    for (const item of page.items) {
      const value = valueOf(item)
      if (value !== null) byPerson[item.person_id] = value
    }
    more = page.next_cursor !== null && page.next_cursor !== cursor
    if (!more) break
    cursor = page.next_cursor ?? undefined
  }
  return { byPerson, truncated: more }
}

// Returns the read with one person's amount replaced, or undefined when there is
// nothing to patch. A truncated read stays truncated.
export function withAmount(
  read: AmountsRead | undefined,
  personId: string,
  amount: string,
): AmountsRead | undefined {
  if (!read) return undefined
  return { ...read, byPerson: { ...read.byPerson, [personId]: amount } }
}
