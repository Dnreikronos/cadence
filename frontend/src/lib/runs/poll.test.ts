import { describe, expect, it } from "vitest"
import { runPollInterval, runPollMs, unrecognizedPollReads } from "./poll"

describe("runPollInterval", () => {
  it("keeps asking while a payment is pending or signed, however many reads were made", () => {
    for (const reads of [0, 5, 500]) {
      expect(runPollInterval(["confirmed", "pending"], reads)).toBe(runPollMs)
      expect(runPollInterval(["signed"], reads)).toBe(runPollMs)
    }
  })

  it("stops once every payment is confirmed, failed or expired", () => {
    expect(runPollInterval(["confirmed", "failed", "expired"], 0)).toBe(false)
    expect(runPollInterval([], 0)).toBe(false)
  })

  it("asks again about an unrecognized status only a bounded number of times", () => {
    for (let reads = 0; reads < unrecognizedPollReads; reads++) {
      expect(runPollInterval(["confirmed", "finalized"], reads)).toBe(runPollMs)
    }
    expect(
      runPollInterval(["confirmed", "finalized"], unrecognizedPollReads),
    ).toBe(false)
    expect(runPollInterval(["finalized"], 1000)).toBe(false)
  })

  it("does not let an unrecognized status cut short the polling of a pending one", () => {
    expect(runPollInterval(["finalized", "pending"], 1000)).toBe(runPollMs)
  })
})
