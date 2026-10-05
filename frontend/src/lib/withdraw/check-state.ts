import { checkable, checkableKey, recordKey, type HeldRecord } from "./held"

// When the screen looks up the withdrawals it kept, kept free of React so it is tested:
// it looks at the ones found on arrival, and at all of them once the person asks again; it
// does not look while a withdrawal is running; and it does not look twice at the same
// saved signatures.

// What was held, and could be asked about, when the screen opened.
export const arrivalOf = (
  records: readonly HeldRecord[],
): ReadonlySet<string> => new Set(records.filter(checkable).map(recordKey))

export type CheckState = {
  // The records to look at.
  include: (record: HeldRecord) => boolean
  // Those records as one value: the lookup starts again when it changes.
  key: string
  // A lookup is under way or about to start, so nothing new is sent.
  checking: boolean
}

export function checkState(input: {
  records: readonly HeldRecord[]
  arrival: ReadonlySet<string>
  // How many times the person asked again.
  tick: number
  // The lookup that last ended: for which records, and at which `tick`.
  checked?: { key: string; tick: number }
  running: boolean
}): CheckState {
  const { records, arrival, tick, checked, running } = input
  const include = (record: HeldRecord) =>
    tick > 0 || arrival.has(recordKey(record))
  const key = checkableKey(records, include)
  return {
    include,
    key,
    checking:
      !running &&
      key !== "" &&
      !(checked?.key === key && checked.tick === tick),
  }
}
