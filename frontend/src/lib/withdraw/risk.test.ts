import { describe, expect, it } from "vitest"
import { revealRiskLevels, unwrapPreparedSchema } from "@/lib/api/schemas"
import { acknowledgePrompt, riskView } from "./risk"

describe("riskView", () => {
  it("warns on an exact and a close match, in different words", () => {
    const exact = riskView("exact")
    const near = riskView("near")
    expect(exact).toMatchObject({ isWarning: true, label: "Exact match" })
    expect(near).toMatchObject({ isWarning: true, label: "Close match" })
    expect(exact.explanation).not.toBe(near.explanation)
  })

  it("adds only a caveat when there is no match, never a warning", () => {
    expect(riskView("none")).toMatchObject({
      level: "none",
      isWarning: false,
      explanation: expect.stringContaining("still public"),
    })
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

  it("does not promise that another amount avoids the link", () => {
    expect(acknowledgePrompt.hint).toMatch(/may avoid a match/)
    expect(acknowledgePrompt.hint).not.toMatch(/To avoid this/)
  })

  it("tells the person it is a public withdrawal that can be linked", () => {
    expect(acknowledgePrompt.body).toMatch(/public/)
    expect(acknowledgePrompt.body).toMatch(/connect the two/)
  })
})

describe("an unknown level from the service", () => {
  const response = (level: unknown) => ({
    request_id: "a".repeat(64),
    transaction: "AQID",
    transaction_version: 1,
    required_signers: ["4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"],
    recent_blockhash: "hash",
    last_valid_block_height: 1,
    reveal_risk: { level, matches: [] },
  })

  it("parses as exact, the safest class, so the warning is shown", () => {
    for (const level of ["very-close", "", 3, null]) {
      const parsed = unwrapPreparedSchema.parse(response(level))
      expect(parsed.reveal_risk.level).toBe("exact")
      expect(riskView(parsed.reveal_risk.level).isWarning).toBe(true)
    }
  })

  it("leaves the known levels alone", () => {
    for (const level of revealRiskLevels) {
      expect(
        unwrapPreparedSchema.parse(response(level)).reveal_risk.level,
      ).toBe(level)
    }
  })
})
