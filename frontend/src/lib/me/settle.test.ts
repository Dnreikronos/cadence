import { describe, expect, it } from "vitest"
import { SETTLE_TIMEOUT_MS, settleState, type Confirmed } from "./settle"

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
