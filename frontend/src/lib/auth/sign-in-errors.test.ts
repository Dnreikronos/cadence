import { describe, expect, it } from "vitest"
import { inviteFailure, signInErrorMessage } from "./sign-in-errors"

describe("inviteFailure", () => {
  it("lets a viewer who is already a member carry on to their area", () => {
    expect(inviteFailure("invite_already_member")).toBeNull()
  })

  it("keeps the code of a known failure", () => {
    expect(inviteFailure("invite_expired")).toBe("invite_expired")
  })

  it.each([undefined, null, "", "some_other_hint", "constructor"])(
    "falls back to a generic failure for %s",
    (hint) => {
      expect(inviteFailure(hint)).toBe("invite_failed")
    },
  )
})

describe("signInErrorMessage", () => {
  it("has nothing to say without an error", () => {
    expect(signInErrorMessage(undefined)).toBeNull()
  })

  it("explains an expired invite", () => {
    expect(signInErrorMessage("invite_expired")).toMatch(/expired/i)
  })

  it("explains an invite sent to another address", () => {
    expect(signInErrorMessage("invite_wrong_email")).toMatch(/another email/i)
  })

  it("explains a session that belongs to no company", () => {
    expect(signInErrorMessage("no_company")).toMatch(/no company/i)
  })

  it("explains an expired sign-in link", () => {
    expect(signInErrorMessage("link_expired")).toMatch(/link has expired/i)
  })

  it.each(["<script>", "constructor"])(
    "shows a generic message for a code it does not know (%s)",
    (code) => {
      expect(signInErrorMessage(code)).toBe(
        signInErrorMessage("sign_in_failed"),
      )
    },
  )
})
