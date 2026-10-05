// After a confirmed apply the finalized read can lag: the balance can come back with
// the old pending amount, and Apply would offer it again. Apply stays off until the
// read shows the change, or this long has passed.
export const SETTLE_TIMEOUT_MS = 30_000

// How long to wait before each read of the balance while it catches up: 2 s, 4 s, 8 s,
// then 12 s, so four reads at most, the last 26 s after the confirmation and before the
// 30 s ceiling, so its answer still counts. Each read costs the service a decrypt and an
// audit row, so the wait grows instead of polling.
export const SETTLE_BACKOFF_MS = [2_000, 4_000, 8_000, 12_000] as const

// The wait before the next read, given how many were made since the confirmation, or
// null once the reads are used up: the timeout then ends the wait.
export function settleReadDelay(readsDone: number): number | null {
  return SETTLE_BACKOFF_MS[readsDone] ?? null
}

type Timer = ReturnType<typeof setTimeout>

// The loop that reads the balance while it catches up. Before each read it asks whether
// the balance is still waiting, so a read that showed the change (or a slot past the
// confirmation) is the last one even if nothing cancelled the loop yet. The returned
// function stops it. The timers are injectable so the loop can be tested.
export function startSettleReads({
  waiting,
  read,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  waiting: () => boolean
  read: () => void
  schedule?: (run: () => void, ms: number) => Timer
  cancel?: (timer: Timer) => void
}): () => void {
  let reads = 0
  let stopped = false
  let timer: Timer | undefined
  const next = () => {
    const delay = settleReadDelay(reads)
    if (delay === null) return
    timer = schedule(() => {
      if (stopped || !waiting()) return
      reads += 1
      read()
      next()
    }, delay)
  }
  next()
  return () => {
    stopped = true
    if (timer !== undefined) cancel(timer)
  }
}

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
