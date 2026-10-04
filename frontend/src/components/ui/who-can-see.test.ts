import { describe, expect, it } from "vitest"
import { whoCanSee } from "./who-can-see"

describe("whoCanSee for a balance", () => {
  it("does not list the recipient as a reader of the company's own balance", () => {
    for (const hasAuditor of [true, false, undefined]) {
      expect(whoCanSee("admin", hasAuditor, "balance")).not.toMatch(/recipient/)
    }
    // A payment does have a counterparty who reads it.
    expect(whoCanSee("admin", false, "payment")).toMatch(/the recipient/)
  })

  it("names the auditor only when one is known to exist", () => {
    expect(whoCanSee("admin", true, "balance")).toMatch(/your auditor/)
    expect(whoCanSee("admin", false, "balance")).toBe(
      "Your company and Cadence can read this amount. The public cannot: on-chain it is ciphertext.",
    )
  })

  it("keeps the longer, safe sentence while it is not known", () => {
    expect(whoCanSee("admin", undefined, "balance")).toMatch(
      /anyone your company has designated/,
    )
  })

  it("still names Cadence to a recipient", () => {
    expect(whoCanSee("recipient", false, "balance")).toMatch(/You and Cadence/)
  })
})
