import { describe, expect, it } from "vitest"
import {
  SETTLE_BACKOFF_MS,
  SETTLE_TIMEOUT_MS,
  settleReadDelay,
  settleState,
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

  // The loop of `useApplyPending`, played on a clock: read after each delay, and stop as
  // soon as `settleState` is not "waiting" any more.
  function play(reads: (at: number) => BalanceRead | undefined) {
    const at: number[] = []
    let now = confirmed.at
    for (let done = 0; ; done++) {
      const delay = settleReadDelay(done)
      if (delay === null) break
      now += delay
      at.push(now - confirmed.at)
      if (settleState(confirmed, reads(now), now) !== "waiting") break
    }
    return at
  }

  it("reads four times, at 2, 6, 14 and 26 s, when the balance never catches up", () => {
    expect(play(() => stale)).toEqual([2_000, 6_000, 14_000, 26_000])
  })

  it("stops at the read that shows the pending amount changed", () => {
    expect(
      play((now) =>
        now - confirmed.at >= 6_000 ? { ...stale, pending: "0" } : stale,
      ),
    ).toEqual([2_000, 6_000])
  })

  it("stops at the read that is past the confirmed slot", () => {
    expect(
      play((now) =>
        now - confirmed.at >= 2_000 ? { ...stale, as_of_slot: 501 } : stale,
      ),
    ).toEqual([2_000])
  })
})
