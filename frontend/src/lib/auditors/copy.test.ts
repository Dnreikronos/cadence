import { describe, expect, it } from "vitest"
import { removalCopy } from "./copy"

// The exact words, so a change to what the admin is told is a visible change here.
describe("removalCopy", () => {
  it("revokes access for an active auditor", () => {
    expect(removalCopy("active")).toEqual({
      description:
        "This removes their access to your payments. Amounts they have already viewed or exported stay with them. To give access back, send a new invite.",
      keep: "Keep access",
      confirm: "Revoke access",
      pending: "Revoking…",
      done: "Access revoked for",
      action: "Revoke access for",
    })
  })

  it("cancels the invite for one that is waiting", () => {
    expect(removalCopy("invited")).toEqual({
      description:
        "They haven't accepted yet, and cancelling withdraws the invite. You can send a new one later.",
      keep: "Keep invite",
      confirm: "Cancel invite",
      pending: "Cancelling…",
      done: "Invite cancelled for",
      action: "Cancel invite for",
    })
  })

  it("removes an expired invite without talking about access", () => {
    expect(removalCopy("invite-expired")).toEqual({
      description:
        "The invite has expired and can't be accepted any more. You can invite them again at any time.",
      keep: "Keep",
      confirm: "Remove invite",
      pending: "Removing…",
      done: "Expired invite removed for",
      action: "Remove expired invite for",
    })
  })
})
