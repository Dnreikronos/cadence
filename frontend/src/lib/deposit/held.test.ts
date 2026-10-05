import { describe, expect, it } from "vitest"
import { canRelease, heldMessage, releaseAfterMs, releaseWarning } from "./held"

describe("releasing a held wrap", () => {
  it("is offered two minutes after the send, not before", () => {
    const record = { at: 1_000_000 }
    expect(releaseAfterMs).toBe(120_000)
    expect(canRelease(record, record.at)).toBe(false)
    expect(canRelease(record, record.at + releaseAfterMs - 1)).toBe(false)
    expect(canRelease(record, record.at + releaseAfterMs)).toBe(true)
  })

  it("says plainly what a release risks, and never promises a new deposit is safe", () => {
    expect(releaseWarning).toMatch(/may still have been sent/)
    expect(releaseWarning).toMatch(/deposit twice/)
    expect(heldMessage).toMatch(
      /couldn't tell whether your last deposit went through/,
    )
  })
})
