// After a confirmed apply the finalized read can lag: the balance can come back with
// the old pending amount, and Apply would offer it again. Apply stays off until the
// read shows the change, or this long has passed.
export const SETTLE_TIMEOUT_MS = 30_000

export type Confirmed = {
  // The pending amount when Apply was pressed.
  pendingBefore: string
  // The slot of the confirmed transaction.
  slot: number
  // Epoch milliseconds of the confirmation.
  at: number
}

export type BalanceRead = { pending: string; as_of_slot: number }

// "waiting": the read has not caught up. "timed-out": it did not within the limit,
// so Apply is back with a note. "settled": the amount changed or the read is past
// the confirmation. "none": nothing was applied.
export type Settle = "none" | "waiting" | "timed-out" | "settled"

export function settleState(
  confirmed: Confirmed | undefined,
  balance: BalanceRead | undefined,
  now: number,
): Settle {
  if (!confirmed) return "none"
  // Nothing pending is nothing to apply twice, whatever the slot says.
  if (
    balance &&
    (balance.pending === "0" ||
      balance.pending !== confirmed.pendingBefore ||
      balance.as_of_slot > confirmed.slot)
  ) {
    return "settled"
  }
  return now - confirmed.at >= SETTLE_TIMEOUT_MS ? "timed-out" : "waiting"
}
