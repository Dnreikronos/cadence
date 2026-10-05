import type { PaymentItem } from "@/lib/api/schemas"
import { collectPages } from "./pages"
import { recentWindowMs, recentlyPaidIds } from "./plan"

// Who was paid in the last 24 hours, read from the company's payments (newest first). It
// reads at most this many pages of 100: more payments than that inside the window is not
// something it can check, and it says so (`tooManyRecent`) rather than answering from a
// part of them, since a run started on a partial answer could pay someone twice.
export const recentPages = 5

type Page = { items: PaymentItem[]; next_cursor: string | null }

// Stops early once a page ends before the window (nothing older matters), and throws a
// `RangeError` when the pages run out with the window still open.
export async function readRecentlyPaid(
  fetchPage: (cursor: string | undefined) => Promise<Page>,
  now: number,
) {
  const payments = await collectPages(
    fetchPage,
    recentPages,
    // Newest first: a page that ends before the window has nothing more to add.
    (page) =>
      page.length > 0 &&
      Date.parse(page[page.length - 1].paid_at) < now - recentWindowMs,
  )
  return recentlyPaidIds(payments, now)
}

export const tooManyRecent = (error: unknown) => error instanceof RangeError

export const tooManyRecentMessage = `More than ${recentPages * 100} payments were made in the last 24 hours, too many to check who was paid, so a run can't be started: it could pay someone twice. Wait until some of them are more than a day old, or check the company's payments first.`
