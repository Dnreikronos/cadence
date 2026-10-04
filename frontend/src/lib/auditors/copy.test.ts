import { describe, expect, it } from "vitest"
import { auditorStatuses } from "@/lib/api/schemas"
import { removalCopy } from "./copy"

describe("removalCopy", () => {
  it("revokes access for an active auditor", () => {
    const copy = removalCopy("active")
    expect(copy.action).toBe("Revoke access for")
    expect(copy.confirm).toBe("Revoke access")
  })

  it("cancels the invite for one that is waiting", () => {
    const copy = removalCopy("invited")
    expect(copy.action).toBe("Cancel invite for")
    expect(copy.confirm).toBe("Cancel invite")
  })

  it("removes an expired invite without talking about access", () => {
    const copy = removalCopy("invite-expired")
    expect(copy.confirm).toBe("Remove invite")
    expect(copy.description).not.toMatch(/access/i)
  })

  it("never promises that access ends instantly", () => {
    for (const status of auditorStatuses) {
      expect(JSON.stringify(removalCopy(status))).not.toMatch(
        /right away|immediately|instantly/i,
      )
    }
  })
})
