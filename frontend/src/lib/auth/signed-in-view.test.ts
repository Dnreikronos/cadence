import { describe, expect, it } from "vitest"
import { signedInView } from "./signed-in-view"

const view = (change: Partial<Parameters<typeof signedInView>[0]> = {}) =>
  signedInView({ invite: null, error: null, demo: false, ...change })

describe("signedInView", () => {
  it("sends a signed-in member on", () => {
    expect(view()).toBe("continue")
  })

  it("explains an invite opened by someone who already belongs to a company", () => {
    expect(view({ invite: "tok" })).toBe("already_member")
    expect(view({ error: "invite_already_member" })).toBe("already_member")
  })

  it("does not call a double click on Continue an error", () => {
    // The second request finds the token spent and sends the person back with the invite.
    expect(view({ invite: "tok", error: "link_expired" })).toBe("continue")
  })

  it("keeps the demo viewer going straight to its area", () => {
    expect(view({ demo: true, invite: "tok" })).toBe("continue")
    expect(view({ demo: true, error: "invite_already_member" })).toBe(
      "continue",
    )
  })

  it("sends a member on past an unrelated error when no invite is involved", () => {
    expect(view({ error: "invite_expired" })).toBe("continue")
  })
})
