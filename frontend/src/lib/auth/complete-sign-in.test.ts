import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerClient } from "@/lib/supabase/server"
import type { Membership } from "@/lib/supabase/membership"

const membershipOf = vi.hoisted(() => vi.fn())
vi.mock("@/lib/supabase/membership", () => ({ membershipOf }))

import {
  completeSignIn,
  intentParams,
  readIntent,
  type SignInIntent,
} from "./complete-sign-in"

const getUser = vi.fn()
const signOut = vi.fn()
const rpc = vi.fn()
const supabase = { auth: { getUser, signOut }, rpc } as unknown as ServerClient

const admin: Membership = { role: "admin", company: { name: "Solaris" } }
const recipient: Membership = {
  role: "recipient",
  company: { name: "Solaris" },
}
const intent = (change: Partial<SignInIntent> = {}): SignInIntent => ({
  invite: null,
  company: null,
  next: null,
  ...change,
})

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } } })
  signOut.mockReset().mockResolvedValue({ error: null })
  rpc.mockReset().mockResolvedValue({ error: null })
  membershipOf.mockReset().mockResolvedValue(null)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("completeSignIn without an intent", () => {
  it("sends a member to their area", async () => {
    membershipOf.mockResolvedValue(recipient)
    expect(await completeSignIn(supabase, intent())).toEqual({ to: "/me" })
    expect(membershipOf).toHaveBeenCalledWith(supabase, "user-1")
    expect(signOut).not.toHaveBeenCalled()
  })

  it("keeps the page they were headed to, query string included", async () => {
    membershipOf.mockResolvedValue(admin)
    const next = "/company/people?tab=invites"
    expect(await completeSignIn(supabase, intent({ next }))).toEqual({
      to: next,
    })
  })

  it("ignores a destination their role may not visit", async () => {
    membershipOf.mockResolvedValue(admin)
    expect(
      await completeSignIn(supabase, intent({ next: "//evil.example" })),
    ).toEqual({ to: "/company" })
  })

  it("ends a session with no company on this device only", async () => {
    expect(await completeSignIn(supabase, intent())).toEqual({
      error: "no_company",
    })
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
  })

  it("fails when the code did not produce a session", async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect(await completeSignIn(supabase, intent())).toEqual({
      error: "sign_in_failed",
    })
    expect(rpc).not.toHaveBeenCalled()
    expect(membershipOf).not.toHaveBeenCalled()
  })
})

describe("completeSignIn creating a company", () => {
  it("creates it and lands on /company", async () => {
    membershipOf.mockResolvedValue(admin)
    expect(
      await completeSignIn(supabase, intent({ company: "Solaris" })),
    ).toEqual({ to: "/company" })
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_company", {
      p_name: "Solaris",
    })
  })

  it("reports a failed creation and ends the session", async () => {
    rpc.mockResolvedValue({ error: { message: "boom" } })
    expect(
      await completeSignIn(supabase, intent({ company: "Solaris" })),
    ).toEqual({ error: "company_failed" })
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
  })

  it("lets a member who signs up twice carry on to their area", async () => {
    rpc.mockResolvedValue({
      error: { message: "already a member of a company" },
    })
    membershipOf.mockResolvedValue(admin)
    expect(
      await completeSignIn(supabase, intent({ company: "Solaris" })),
    ).toEqual({ to: "/company" })
    expect(signOut).not.toHaveBeenCalled()
  })
})

describe("completeSignIn accepting an invite", () => {
  it("accepts it with the token and lands on the role's area", async () => {
    membershipOf.mockResolvedValue(recipient)
    expect(await completeSignIn(supabase, intent({ invite: "tok-1" }))).toEqual(
      { to: "/me" },
    )
    expect(rpc).toHaveBeenCalledExactlyOnceWith("accept_invite", {
      p_token: "tok-1",
    })
  })

  it.each([
    ["invite_expired"],
    ["invite_wrong_email"],
    ["invite_not_found"],
    ["invite_person_removed"],
  ])("shows %s and ends the session when it did not apply", async (hint) => {
    rpc.mockResolvedValue({ error: { hint } })
    expect(await completeSignIn(supabase, intent({ invite: "tok-1" }))).toEqual(
      { error: hint },
    )
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
  })

  it("falls back to a generic failure for an unknown hint", async () => {
    rpc.mockResolvedValue({ error: { hint: "nope" } })
    expect(await completeSignIn(supabase, intent({ invite: "tok-1" }))).toEqual(
      { error: "invite_failed" },
    )
  })

  it("tells a member who opened someone's invite, and keeps their session", async () => {
    rpc.mockResolvedValue({ error: { hint: "invite_already_member" } })
    membershipOf.mockResolvedValue(admin)
    expect(
      await completeSignIn(supabase, intent({ invite: "tok-1", next: "/me" })),
    ).toEqual({ to: "/sign-in?invite=tok-1&error=invite_already_member" })
    expect(signOut).not.toHaveBeenCalled()
  })

  it("also tells a member who reopens a link that no longer works", async () => {
    rpc.mockResolvedValue({ error: { hint: "invite_already_accepted" } })
    membershipOf.mockResolvedValue(recipient)
    expect(await completeSignIn(supabase, intent({ invite: "tok-1" }))).toEqual(
      { to: "/sign-in?invite=tok-1&error=invite_already_member" },
    )
  })
})

describe("completeSignIn when the membership lookup fails", () => {
  beforeEach(() => {
    membershipOf.mockRejectedValue(new Error("memberships lookup failed: 500"))
  })

  it("keeps the session: a failed lookup is not 'no company'", async () => {
    expect(await completeSignIn(supabase, intent())).toEqual({
      error: "lookup_failed",
    })
    expect(signOut).not.toHaveBeenCalled()
  })

  it("does not throw, so the sign-in page is not a 500", async () => {
    await expect(
      completeSignIn(supabase, intent({ invite: "tok-1" })),
    ).resolves.toEqual({ error: "lookup_failed" })
  })
})

describe("the intent in query params and form fields", () => {
  it("round-trips through the params", () => {
    const original = intent({
      invite: "tok",
      company: "A & B",
      next: "/me?x=1",
    })
    expect(readIntent(intentParams(original))).toEqual(original)
  })

  it("reads only text, trimmed, and treats blanks as absent", () => {
    const form = new FormData()
    form.set("invite", "  tok  ")
    form.set("company", "   ")
    form.set("next", new File([""], "x.txt"))
    expect(readIntent(form)).toEqual(intent({ invite: "tok" }))
  })

  it("writes nothing for an absent intent", () => {
    expect(intentParams(intent()).toString()).toBe("")
  })
})
