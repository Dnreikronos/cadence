import { describe, expect, it } from "vitest"
import { guard, safeNext, type Role } from "./guard"

describe("guard", () => {
  it("sends a signed-out visit to /company to sign-in, remembering where it was going", () => {
    expect(guard("/company", null)).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fcompany",
    })
  })

  it.each(["/", "/sign-in", "/companyx", "/media"])(
    "lets a signed-out visit to %s through",
    (path) => {
      expect(guard(path, null)).toEqual({
        kind: "next",
      })
    },
  )

  it.each<[string, Role]>([
    ["/company/people", "admin"],
    ["/me", "recipient"],
    ["/audit/export", "auditor"],
  ])("lets %s through for a member holding %s", (path, role) => {
    expect(guard(path, role)).toEqual({
      kind: "next",
    })
  })

  it("keeps the query string in `next`, encoded, so a filtered page survives sign-in", () => {
    expect(guard("/company/people", null, "?tab=invites&q=a b")).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fcompany%2Fpeople%3Ftab%3Dinvites%26q%3Da%20b",
    })
  })

  it("does not carry a query string through for a public page", () => {
    expect(guard("/sign-in", null, "?next=%2Fme")).toEqual({ kind: "next" })
  })

  it("sends a recipient away from /company to their own area, not back to sign-in", () => {
    expect(guard("/company", "recipient")).toEqual({
      kind: "redirect",
      to: "/me",
    })
  })
})

describe("safeNext", () => {
  it("returns to where an admin was going, query string included", () => {
    expect(safeNext("/company/people?tab=invites", "admin")).toBe(
      "/company/people?tab=invites",
    )
  })

  it("sends a recipient to their own area when there is nowhere to return to", () => {
    expect(safeNext(null, "recipient")).toBe("/me")
  })

  it("ignores a path the role may not visit", () => {
    expect(safeNext("/company", "auditor")).toBe("/audit")
  })

  it.each([
    "//evil.example",
    "https://evil.example/me",
    "/\\evil.example",
    "me",
    // Dot segments collapse into a scheme-relative URL.
    "/me/..//evil.example",
    "/me/../\\evil.example",
    // The URL parser drops tabs and newlines, so these read as "//evil.example".
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "\t//evil.example",
    "/me%2F..%2F..//evil.example",
    "javascript:alert(1)",
    "",
  ])("never leaves the site for %j", (next) => {
    expect(safeNext(next, "recipient")).toBe("/me")
  })

  it("does not follow a dot segment out of the role's area", () => {
    expect(safeNext("/me/../company", "recipient")).toBe("/me")
    expect(safeNext("/me/../company", "admin")).toBe("/company")
  })

  it("returns a path, never a full URL", () => {
    expect(safeNext("/me/history?page=2", "recipient")).toBe(
      "/me/history?page=2",
    )
    expect(safeNext("/me//history", "recipient")).toBe("/me//history")
  })
})
