import type { PersonAmount } from "@/lib/api/schemas"

type Page = { items: PersonAmount[]; next_cursor: string | null }

// A page is at most 100 rows, so this covers a payroll of 5,000 people.
const maxPages = 50

// Every amount of the company, by person id, in base units. Follows the cursor to
// the end; a cursor that does not advance would loop forever, so it stops there.
export async function readAllAmounts(
  fetchPage: (cursor?: string) => Promise<Page>,
): Promise<Record<string, string>> {
  const amounts: Record<string, string> = {}
  let cursor: string | undefined
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await fetchPage(cursor)
    for (const item of page.items) amounts[item.person_id] = item.amount
    if (page.next_cursor === null || page.next_cursor === cursor) break
    cursor = page.next_cursor
  }
  return amounts
}
