import { describe, expect, it } from "vitest"
import { canSee, payments, type Perspective } from "./landing-data"

function visibleIds(perspective: Perspective) {
  return payments
    .filter((payment) => canSee(perspective, payment))
    .map((payment) => payment.id)
}

describe("canSee", () => {
  it("matches the PRD's who-sees-what table", () => {
    expect(visibleIds("company")).toEqual([
      "bruno",
      "ana",
      "mariana",
      "diego",
      "northwind",
    ])
    expect(visibleIds("auditor")).toEqual([
      "bruno",
      "ana",
      "mariana",
      "diego",
      "northwind",
    ])
    expect(visibleIds("cadence")).toEqual([
      "bruno",
      "ana",
      "mariana",
      "diego",
      "northwind",
    ])
    expect(visibleIds("recipient")).toEqual(["bruno"])
    expect(visibleIds("public")).toEqual([])
  })
})
