import { describe, expect, it } from "vitest"
import { revealRiskLevels } from "@/lib/api/schemas"
import { acknowledgePrompt, riskView } from "./risk"

describe("riskView", () => {
  it("warns on an exact and a close match, in different words", () => {
    const exact = riskView("exact")
    const near = riskView("near")
    expect(exact).toMatchObject({ isWarning: true, label: "Exact match" })
    expect(near).toMatchObject({ isWarning: true, label: "Close match" })
    expect(exact.explanation).not.toBe(near.explanation)
  })

  it("says nothing more than the badge when there is no match", () => {
    expect(riskView("none")).toMatchObject({
      level: "none",
      isWarning: false,
      explanation: "",
    })
  })

  it("reads a level it does not know as an exact match", () => {
    expect(riskView("very-close")).toEqual(riskView("exact"))
    expect(riskView("")).toEqual(riskView("exact"))
  })

  it("covers every level the contract has", () => {
    for (const level of revealRiskLevels) {
      expect(riskView(level).level).toBe(level)
    }
  })
})

describe("the copy", () => {
  it("never carries an amount, since it is written without one", () => {
    const text = [
      ...Object.values(acknowledgePrompt),
      ...revealRiskLevels.flatMap((level) => {
        const view = riskView(level)
        return [view.label, view.explanation]
      }),
    ].join(" ")
    expect(text).not.toMatch(/\d|\$/)
  })

  it("tells the person it is a public withdrawal that can be linked", () => {
    expect(acknowledgePrompt.body).toMatch(/public/)
    expect(acknowledgePrompt.body).toMatch(/connect the two/)
  })
})
