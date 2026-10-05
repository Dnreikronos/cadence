import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  // Supabase is configured, as it is where anyone can sign in.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321")
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

  it("refuses an Origin on the same host but another port or scheme", async () => {
    for (const origin of ["http://localhost:3001", "https://localhost:3000"]) {
      const response = await post(
        { token_hash: "abc", type: "email" },
        { origin },
      )
      expect(response.status, origin).toBe(403)
    }
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it("answers 400, not a 500, to a body that is not a form", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3000/auth/confirm/verify", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: '{"token_hash":"abc"}',
      }),
    )
    expect(response.status).toBe(400)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it("lets no cache keep any of its answers", async () => {
    const ok = await post({ token_hash: "abc", type: "email" })
    const refused = await post({}, { origin: "https://evil.example" })
    const expired = await post({ type: "email" })
    for (const response of [ok, refused, expired]) {
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
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

  describe("without Supabase configured", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    })

    it("goes back to the form with the not-configured notice, never a 500", async () => {
      const response = await post({ token_hash: "abc", type: "email" })
      expect(response.status).toBe(303)
      expect(place(response)).toBe("/sign-in?error=not_configured")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(verifyOtp).not.toHaveBeenCalled()
      expect(completeSignIn).not.toHaveBeenCalled()
    })

    it("keeps the form it came from, with its intent", async () => {
      expect(
        place(
          await post({
            token_hash: "abc",
            type: "signup",
            company: "Solaris",
          }),
        ),
      ).toBe("/sign-up?company=Solaris&error=not_configured")
    })

    it("still refuses another site first", async () => {
      const response = await post(
        { token_hash: "abc", type: "email" },
        { origin: "https://evil.example" },
      )
      expect(response.status).toBe(403)
    })
  })

  describe("when Supabase cannot be reached", () => {
    it("goes back to the form, and logs the kind of error and nothing it carried", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      verifyOtp.mockRejectedValue(new TypeError("fetch failed: token abc123"))

      const response = await post({ token_hash: "abc123", type: "email" })

      expect(response.status).toBe(303)
      expect(place(response)).toBe("/sign-in?error=sign_in_failed")
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "confirm verify failed",
        "TypeError",
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain("abc123")
    })

    it("does the same when finishing the sign-in throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      completeSignIn.mockRejectedValue(new Error("lookup failed"))
      const response = await post({ token_hash: "abc", type: "email" })
      expect(place(response)).toBe("/sign-in?error=sign_in_failed")
    })
  })
})
