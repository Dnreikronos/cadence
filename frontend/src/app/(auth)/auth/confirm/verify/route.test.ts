import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyOtp = vi.hoisted(() => vi.fn())
const completeSignIn = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}))
vi.mock("@/lib/auth/complete-sign-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/complete-sign-in")>()),
  completeSignIn,
}))

import { POST } from "./route"

function post(
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: "http://localhost:3000" },
) {
  const body = new URLSearchParams(fields)
  return POST(
    new NextRequest("http://localhost:3000/auth/confirm/verify", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
    }),
  )
}

// The location is relative: it must follow the host the browser used, not the server's own.
const place = (response: Response) => response.headers.get("location")

beforeEach(() => {
  verifyOtp.mockReset().mockResolvedValue({ error: null })
  completeSignIn.mockReset().mockResolvedValue({ to: "/company" })
})

describe("POST /auth/confirm/verify", () => {
  it("spends the token and signs in", async () => {
    const response = await post({ token_hash: "abc", type: "email" })
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({
      token_hash: "abc",
      type: "email",
    })
    expect(place(response)).toBe("/company")
  })

  it("redirects with 303 so the browser follows with a GET", async () => {
    expect((await post({ token_hash: "abc", type: "email" })).status).toBe(303)
    expect((await post({ type: "email" })).status).toBe(303)
  })

  it("finishes sign-in with the intent from the form", async () => {
    await post({
      token_hash: "abc",
      type: "signup",
      invite: "tok",
      next: "/me",
    })
    expect(completeSignIn).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      invite: "tok",
      company: null,
      next: "/me",
    })
  })

  it("refuses a post from another site before touching the token", async () => {
    const response = await post(
      { token_hash: "abc", type: "email" },
      { origin: "https://evil.example" },
    )
    expect(response.status).toBe(403)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it("refuses a post without an Origin", async () => {
    const response = await post({ token_hash: "abc", type: "email" }, {})
    expect(response.status).toBe(403)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it.each([
    ["no token", { type: "email" }],
    ["an empty token", { token_hash: "", type: "email" }],
    [
      "a type the templates never write",
      { token_hash: "abc", type: "recovery" },
    ],
    ["no type", { token_hash: "abc" }],
  ])(
    "sends %s back as an expired link, without verifying",
    async (_, fields) => {
      expect(place(await post(fields))).toBe("/sign-in?error=link_expired")
      expect(verifyOtp).not.toHaveBeenCalled()
    },
  )

  it("sends an expired token back to the form it came from, intent kept", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "expired" } })
    expect(
      place(
        await post({
          token_hash: "abc",
          type: "email",
          invite: "tok",
          next: "/me",
        }),
      ),
    ).toBe("/sign-in?next=%2Fme&invite=tok&error=link_expired")
    expect(completeSignIn).not.toHaveBeenCalled()
  })

  it("sends an expired sign-up link back to sign-up with the company name", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "expired" } })
    expect(
      place(
        await post({ token_hash: "abc", type: "signup", company: "Solaris" }),
      ),
    ).toBe("/sign-up?company=Solaris&error=link_expired")
  })

  it("shows an invite that did not apply on the form, with the invite kept", async () => {
    completeSignIn.mockResolvedValue({ error: "invite_wrong_email" })
    expect(
      place(await post({ token_hash: "abc", type: "email", invite: "tok" })),
    ).toBe("/sign-in?invite=tok&error=invite_wrong_email")
  })

  it("shows a missing company on the form", async () => {
    completeSignIn.mockResolvedValue({ error: "no_company" })
    expect(place(await post({ token_hash: "abc", type: "email" }))).toBe(
      "/sign-in?error=no_company",
    )
  })
})
