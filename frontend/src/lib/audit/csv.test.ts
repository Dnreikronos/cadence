import { describe, expect, it } from "vitest"
import { csvFilename } from "./csv"

const day = new Date(2026, 9, 4, 15, 30)

describe("csvFilename", () => {
  it("names the company and the local date", () => {
    expect(csvFilename("Solaris", day)).toBe(
      "cadence-audit-solaris-2026-10-04.csv",
    )
  })

  it("pads month and day", () => {
    expect(csvFilename("A", new Date(2026, 0, 5))).toBe(
      "cadence-audit-a-2026-01-05.csv",
    )
  })

  it("reduces any name to a safe file name", () => {
    expect(csvFilename("  Acme & Sons / Ltda.  ", day)).toBe(
      "cadence-audit-acme-sons-ltda-2026-10-04.csv",
    )
    expect(csvFilename("../../etc\\passwd", day)).toBe(
      "cadence-audit-etc-passwd-2026-10-04.csv",
    )
  })

  it("falls back when nothing usable is left", () => {
    expect(csvFilename("日本語", day)).toBe(
      "cadence-audit-company-2026-10-04.csv",
    )
    expect(csvFilename("", day)).toBe("cadence-audit-company-2026-10-04.csv")
  })

  it("caps a long name without a trailing dash", () => {
    const name = csvFilename(`${"a".repeat(39)} bbbb`, day)
    expect(name).toBe(`cadence-audit-${"a".repeat(39)}-2026-10-04.csv`)
  })
})
