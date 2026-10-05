import { otherTabMessage, type Acquired } from "./flow-lock"

// Letting go of a hold on purpose, safely. The person decided on what they saw, and the
// hold may have changed since (another tab released it and sent again, or looked it up and
// found it settled): a release made on a stale view would erase the record of something in
// flight. So the lock of the flow is taken first (nothing is sending or looking meanwhile),
// what is saved is read again, and only the very record the person saw, still two minutes
// old, is removed.

export type ReleaseOutcome = "released" | "busy" | "changed" | "too-soon"

// How long a record must have been unresolved before it can be released: long enough for
// its blockhash to have run out and for the service to have been asked more than once.
export const releaseAfterMs = 2 * 60_000

export async function releaseUnderLock<T extends { at: number }>({
  lock,
  read,
  seen,
  same,
  remove,
  now = Date.now(),
  afterMs = releaseAfterMs,
}: {
  lock: () => Promise<Acquired>
  // What is saved now for what is being released.
  read: () => readonly T[]
  // What the person saw when they decided: the record, or the records of one person.
  seen: readonly T[]
  // Whether two records are the same send (the ids, the signature and the time).
  same: (a: T, b: T) => boolean
  // Removes exactly these records.
  remove: (records: readonly T[]) => void
  now?: number
  afterMs?: number
}): Promise<ReleaseOutcome> {
  const got = await lock()
  if (got.status === "busy") return "busy"
  try {
    const current = read()
    const unchanged =
      seen.length > 0 &&
      current.length === seen.length &&
      seen.every((record) => current.some((saved) => same(saved, record)))
    if (!unchanged) return "changed"
    if (current.some((record) => now - record.at < afterMs)) return "too-soon"
    remove(current)
    return "released"
  } finally {
    got.lease.release()
  }
}

// Saved state that could not be read is released the same way, under the lock: nothing
// else is sending or looking while it goes.
export async function releaseUnreadableUnderLock(
  lock: () => Promise<Acquired>,
  clear: () => void,
): Promise<ReleaseOutcome> {
  const got = await lock()
  if (got.status === "busy") return "busy"
  try {
    clear()
    return "released"
  } finally {
    got.lease.release()
  }
}

// What the person reads when a release was refused, or null when it went through.
export function releaseMessage(
  outcome: ReleaseOutcome,
  what: Parameters<typeof otherTabMessage>[0],
): string | null {
  switch (outcome) {
    case "released":
      return null
    case "busy":
      return otherTabMessage(what)
    case "changed":
      return "What was held changed in another tab, so nothing was released. Look at it again before you decide."
    case "too-soon":
      return "It can only be released two minutes after it was sent."
  }
}
