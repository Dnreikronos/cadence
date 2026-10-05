import { describe, expect, it } from "vitest"
import {
  SETTLE_BACKOFF_MS,
  SETTLE_TIMEOUT_MS,
  settleReadDelay,
  settleState,
  startSettleReads,
  type BalanceRead,
  type Confirmed,
} from "./settle"

const confirmed: Confirmed = {
  pendingBefore: "2000000",
  slot: 500,
  at: 10_000,
}
const stale = { pending: "2000000", as_of_slot: 500 }

describe("settleState", () => {
  it("has nothing to wait for before anything was applied", () => {
    expect(settleState(undefined, stale, 0)).toBe("none")
  })

  it("waits while the read still shows the old amount at or before the confirmed slot", () => {
    expect(settleState(confirmed, stale, 10_500)).toBe("waiting")
    expect(settleState(confirmed, { ...stale, as_of_slot: 499 }, 10_500)).toBe(
      "waiting",
    )
    // No read yet counts as not caught up.
    expect(settleState(confirmed, undefined, 10_500)).toBe("waiting")
  })

  it("settles when the pending amount changed", () => {
    expect(settleState(confirmed, { ...stale, pending: "0" }, 10_500)).toBe(
      "settled",
    )
    expect(
      settleState(confirmed, { ...stale, pending: "300000" }, 10_500),
    ).toBe("settled")
  })

  it("settles at pending 0, since there is nothing left to apply twice", () => {
    expect(
      settleState(
        { ...confirmed, pendingBefore: "0" },
        { ...stale, pending: "0" },
        10_500,
      ),
    ).toBe("settled")
  })

  it("settles when the read is past the confirmed slot, even at the same amount", () => {
    expect(settleState(confirmed, { ...stale, as_of_slot: 501 }, 10_500)).toBe(
      "settled",
    )
  })

  it("gives up after 30 seconds and lets Apply come back", () => {
    expect(
      settleState(confirmed, stale, confirmed.at + SETTLE_TIMEOUT_MS - 1),
    ).toBe("waiting")
    expect(
      settleState(confirmed, stale, confirmed.at + SETTLE_TIMEOUT_MS),
    ).toBe("timed-out")
  })

  it("settles late rather than staying timed out when the read catches up", () => {
    expect(
      settleState(
        confirmed,
        { ...stale, pending: "0" },
        confirmed.at + SETTLE_TIMEOUT_MS * 2,
      ),
    ).toBe("settled")
  })
})

describe("settleReadDelay", () => {
  it("waits 2 s, 4 s, 8 s and 12 s, then has no more reads", () => {
    expect([0, 1, 2, 3, 4, 5].map(settleReadDelay)).toEqual([
      2_000,
      4_000,
      8_000,
      12_000,
      null,
      null,
    ])
  })

  it("makes at most four reads, each waiting longer than the one before", () => {
    expect(SETTLE_BACKOFF_MS).toHaveLength(4)
    for (let i = 1; i < SETTLE_BACKOFF_MS.length; i++) {
      expect(SETTLE_BACKOFF_MS[i]).toBeGreaterThan(SETTLE_BACKOFF_MS[i - 1])
    }
  })

  it("ends its last read before the ceiling, so the answer still counts", () => {
    const last = SETTLE_BACKOFF_MS.reduce((total, wait) => total + wait, 0)
    expect(last).toBeLessThan(SETTLE_TIMEOUT_MS)
  })
})

// The loop `useApplyPending` runs, on a clock the test moves. The balance each read
// returns is the test's, and `waiting` is what the hook asks: `settleState` over the
// latest read, as the hook's own effect keeps it.
describe("startSettleReads", () => {
  function run(
    balanceAt: (elapsed: number) => BalanceRead | undefined,
    cancelAt?: number,
  ) {
    let now = confirmed.at
    let latest: BalanceRead | undefined
    const timers: { at: number; run: () => void; live: boolean }[] = []
    const reads: number[] = []
    const stop = startSettleReads({
      waiting: () => settleState(confirmed, latest, now) === "waiting",
      read: () => {
        reads.push(now - confirmed.at)
        // The answer lands before the next timer.
        latest = balanceAt(now - confirmed.at)
      },
      schedule: (fn, ms) => {
        const timer = { at: now + ms, run: fn, live: true }
        timers.push(timer)
        return timer as never
      },
      cancel: (timer) =>
        void ((timer as never as { live: boolean }).live = false),
    })
    // Fire the timers in order, as the clock reaches each. A cancelled timer does not
    // fire, but a loop that was never cancelled must still stop on its own.
    for (;;) {
      const due = timers.filter((t) => t.live).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      if (cancelAt !== undefined && due.at - confirmed.at > cancelAt) {
        stop()
        // What a missing `stop` would do: the timer fires anyway.
        due.live = true
      }
      now = due.at
      due.live = false
      due.run()
    }
    return reads
  }

  it("reads four times, at 2, 6, 14 and 26 s, when the balance never catches up", () => {
    expect(run(() => stale)).toEqual([2_000, 6_000, 14_000, 26_000])
  })

  it("stops at the read that shows the pending amount changed, with no cancel needed", () => {
    expect(
      run((elapsed) => (elapsed >= 6_000 ? { ...stale, pending: "0" } : stale)),
    ).toEqual([2_000, 6_000])
  })

  it("stops at the read that shows a slot past the confirmation", () => {
    expect(
      run((elapsed) =>
        elapsed >= 2_000 ? { ...stale, as_of_slot: 501 } : stale,
      ),
    ).toEqual([2_000])
  })

  it("stops when the balance changes between two reads, before the next one is made", () => {
    // The read at 6 s is stale, but the change shows up before the timer for 14 s.
    let seen: BalanceRead | undefined = stale
    expect(
      run((elapsed) => {
        if (elapsed >= 6_000) seen = { ...stale, pending: "0" }
        return seen
      }),
    ).toEqual([2_000, 6_000])
  })

  it("makes no read once it is stopped", () => {
    expect(run(() => stale, 2_000)).toEqual([2_000])
  })

  it("waits the backoff delays before each read, and never more than four reads", () => {
    const delays: number[] = []
    const stop = startSettleReads({
      waiting: () => true,
      read: () => {},
      schedule: (fn, ms) => {
        delays.push(ms)
        fn()
        return 0 as never
      },
      cancel: () => {},
    })
    stop()
    expect(delays).toEqual([...SETTLE_BACKOFF_MS])
  })
})
