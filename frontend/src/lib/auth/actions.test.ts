import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignInState } from "./actions"
import type { SignInIntent } from "./complete-sign-in"

const config = vi.hoisted(() => ({ supabaseConfigured: true, demo: false }))
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }))
const store = vi.hoisted(() => ({
  delete: vi.fn(),
  getAll: vi.fn((): { name: string }[] => []),
}))
const membershipOf = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
}))
const rpc = vi.hoisted(() => vi.fn())
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect:${to}`)
  }),
)

vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => config.supabaseConfigured,
}))
vi.mock("@/lib/demo/mode", () => ({ isDemoEnabled: async () => config.demo }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth, rpc }),
}))
vi.mock("@/lib/supabase/membership", () => ({ membershipOf }))
vi.mock("next/headers", () => ({
  cookies: async () => store,
  headers: async () => requestHeaders.current,
}))
vi.mock("next/navigation", () => ({ redirect }))

import { signIn, signOut, signOutEverywhere } from "./actions"

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}
const email: SignInState = { step: "email" }
const noIntent: SignInIntent = { invite: null, company: null, next: null }
const codeStep = (intent = noIntent): SignInState => ({
  step: "code",
  email: "ana@solaris.test",
  intent,
})

beforeEach(() => {
  Object.assign(config, { supabaseConfigured: true, demo: false })
  requestHeaders.current = new Headers({ origin: "http://localhost:3000" })
  store.delete.mockClear()
  store.getAll.mockReset().mockReturnValue([])
  auth.signInWithOtp.mockReset().mockResolvedValue({ error: null })
  auth.verifyOtp.mockReset().mockResolvedValue({ error: null })
  auth.getUser.mockReset().mockResolvedValue({ data: { user: { id: "u1" } } })
  auth.signOut.mockReset().mockResolvedValue({ error: null })
  rpc.mockReset().mockResolvedValue({ error: null })
  membershipOf.mockReset().mockResolvedValue(null)
  redirect.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => vi.unstubAllEnvs())

describe("signIn: asking for a code", () => {
  it("emails a code and moves to the code step", async () => {
    expect(await signIn(email, form({ email: "  ana@solaris.test " }))).toEqual(
      { step: "code", email: "ana@solaris.test", intent: noIntent },
    )
    expect(auth.signInWithOtp).toHaveBeenCalledOnce()
  })

  it("rejects an address that is not an email, without calling Supabase", async () => {
    expect(await signIn(email, form({ email: "ana" }))).toMatchObject({
      step: "email",
      email: "ana",
      error: "Enter a valid email.",
    })
    expect(auth.signInWithOtp).not.toHaveBeenCalled()
  })

  it("never creates an account on a plain sign-in", async () => {
    await signIn(email, form({ email: "ana@solaris.test" }))
    expect(auth.signInWithOtp.mock.calls[0][0].options.shouldCreateUser).toBe(
      false,
    )
  })

  it.each([
    ["an invite", { invite: "tok" }],
    ["a company", { company: "Solaris" }],
  ])("creates an account when it comes with %s", async (_, extra) => {
    await signIn(email, form({ email: "ana@solaris.test", ...extra }))
    expect(auth.signInWithOtp.mock.calls[0][0].options.shouldCreateUser).toBe(
      true,
    )
  })

  it("asks for the company's name on sign-up", async () => {
    expect(
      await signIn(email, form({ email: "ana@solaris.test", company: "  " })),
    ).toMatchObject({ step: "email", error: "Enter your company's name." })
    expect(auth.signInWithOtp).not.toHaveBeenCalled()
  })

  it("puts the intent in the emailed link, which needs a query for the token", async () => {
    await signIn(
      email,
      form({ email: "ana@solaris.test", invite: "tok", next: "/me" }),
    )
    const link = new URL(
      auth.signInWithOtp.mock.calls[0][0].options.emailRedirectTo,
    )
    expect(link.origin + link.pathname).toBe(
      "http://localhost:3000/auth/confirm",
    )
    expect(Object.fromEntries(link.searchParams)).toEqual({
      invite: "tok",
      next: "/me",
    })
  })

  it("defaults the destination in the link so it always has a query", async () => {
    await signIn(email, form({ email: "ana@solaris.test" }))
    const link = new URL(
      auth.signInWithOtp.mock.calls[0][0].options.emailRedirectTo,
    )
    expect(link.searchParams.get("next")).toBe("/")
  })

  it("does not send without an origin to build the link from", async () => {
    requestHeaders.current = new Headers()
    expect(
      await signIn(email, form({ email: "ana@solaris.test" })),
    ).toMatchObject({
      step: "email",
      error: expect.stringMatching(/could not send/i),
    })
    expect(auth.signInWithOtp).not.toHaveBeenCalled()
  })

  describe("the origin of the emailed link", () => {
    const linkOf = () =>
      new URL(auth.signInWithOtp.mock.calls[0][0].options.emailRedirectTo)

    it("is the configured site when there is one", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.cadence.example")
      await signIn(email, form({ email: "ana@solaris.test" }))
      expect(linkOf().origin).toBe("https://app.cadence.example")
      expect(linkOf().pathname).toBe("/auth/confirm")
    })

    it("ignores a spoofed Origin when the site is configured", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.cadence.example")
      requestHeaders.current = new Headers({
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
      })
      await signIn(email, form({ email: "ana@solaris.test", invite: "tok" }))
      expect(linkOf().origin).toBe("https://app.cadence.example")
      expect(linkOf().searchParams.get("invite")).toBe("tok")
    })

    it("falls back to the request's Origin in development and tests", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "")
      await signIn(email, form({ email: "ana@solaris.test" }))
      expect(linkOf().origin).toBe("http://localhost:3000")
    })

    it("does not fall back to the request in production, and sends nothing", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.cadence.example")
      await signIn(email, form({ email: "ana@solaris.test" }))
      expect(linkOf().origin).toBe("https://app.cadence.example")

      auth.signInWithOtp.mockClear()
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "")
      await expect(
        signIn(email, form({ email: "ana@solaris.test" })),
      ).rejects.toThrow(/NEXT_PUBLIC_SITE_URL is required/)
      expect(auth.signInWithOtp).not.toHaveBeenCalled()
    })
  })

  it("keeps the company name when sending a new code from the code step", async () => {
    const state = codeStep({ ...noIntent, company: "Solaris" })
    await signIn(state, form({ step: "send", email: "ana@solaris.test" }))
    expect(auth.signInWithOtp.mock.calls[0][0].options.shouldCreateUser).toBe(
      true,
    )
  })

  it.each([
    [429, "over_request_rate_limit", /too many attempts/i],
    [500, "unexpected_failure", /could not send/i],
    // A 429 that is not the per-IP limit is no reason to say "too many".
    [429, "some_other_limit", /could not send/i],
  ])("explains a Supabase failure (%s %s)", async (status, code, message) => {
    auth.signInWithOtp.mockResolvedValue({
      error: { status, code, message: "x" },
    })
    expect(
      await signIn(email, form({ email: "ana@solaris.test" })),
    ).toMatchObject({ step: "email", error: expect.stringMatching(message) })
  })
})

describe("signIn: an email with no account", () => {
  const noSignups = { status: 422, code: "otp_disabled", message: "no signups" }
  const tooSoon = {
    status: 429,
    code: "over_email_send_rate_limit",
    message: "for security purposes, wait",
  }
  // What GoTrue does with shouldCreateUser: false: an address with an account is mailed
  // (and rate-limited per address, answering 429 on a quick repeat); one without answers
  // `otp_disabled` before it ever applies that limit.
  const gotrue = (known: string) => {
    let sent = 0
    auth.signInWithOtp.mockImplementation(
      async ({ email: to }: { email: string }) => {
        if (to !== known) return { error: noSignups }
        return { error: sent++ ? tooSoon : null }
      },
    )
  }
  const ask = (to: string) => signIn(email, form({ email: to }))
  // The address is the one thing that legitimately differs.
  const sameScreen = (state: SignInState, address: string) => ({
    ...state,
    email: address,
  })

  it("shows the code step for a first request, known or not", async () => {
    gotrue("ana@solaris.test")
    const known = await ask("ana@solaris.test")
    const unknown = await ask("nobody@solaris.test")
    expect(known.step).toBe("code")
    expect(unknown).toEqual(sameScreen(known, "nobody@solaris.test"))
  })

  it("answers a quick repeat the same way for a known and an unknown email", async () => {
    gotrue("ana@solaris.test")
    await ask("ana@solaris.test")
    await ask("nobody@solaris.test")
    // The second request for the known address is the one GoTrue refuses with a 429.
    const knownAgain = await ask("ana@solaris.test")
    const unknownAgain = await ask("nobody@solaris.test")
    expect(auth.signInWithOtp).toHaveBeenCalledTimes(4)
    expect(knownAgain.step).toBe("code")
    expect(unknownAgain).toEqual(sameScreen(knownAgain, "nobody@solaris.test"))
  })

  it("does the same from the code step's 'Send a new code'", async () => {
    gotrue("ana@solaris.test")
    const resend = (to: string) =>
      signIn(
        { step: "code", email: to, intent: noIntent },
        form({ step: "send", email: to }),
      )
    await resend("ana@solaris.test")
    const knownAgain = await resend("ana@solaris.test")
    const unknownAgain = await resend("nobody@solaris.test")
    expect(unknownAgain).toEqual(sameScreen(knownAgain, "nobody@solaris.test"))
    expect(knownAgain).not.toHaveProperty("error")
  })

  it("says nothing about a company or a limit, and logs neither as a failure", async () => {
    gotrue("ana@solaris.test")
    await ask("ana@solaris.test")
    for (const to of ["ana@solaris.test", "nobody@solaris.test"]) {
      const state = await ask(to)
      expect(state.step).toBe("code")
      expect(state).not.toHaveProperty("error")
    }
    expect(console.error).not.toHaveBeenCalled()
  })

  it("fails the code the same way as any wrong code", async () => {
    auth.verifyOtp.mockResolvedValue({
      error: { message: "Token has expired" },
    })
    expect(
      await signIn(codeStep(), form({ step: "verify", code: "123456" })),
    ).toMatchObject({
      step: "code",
      error: "That code is wrong or has expired.",
    })
  })
})

describe("signIn: checking the code", () => {
  const verify = (code: string, state = codeStep()) =>
    signIn(state, form({ step: "verify", code }))

  it.each(["12345", "1234567", "abcdef", "", "12 456"])(
    "rejects %j before asking Supabase",
    async (code) => {
      expect(await verify(code)).toMatchObject({
        step: "code",
        error: "Enter the 6-digit code.",
      })
      expect(auth.verifyOtp).not.toHaveBeenCalled()
    },
  )

  it("verifies the code against the email it was sent to", async () => {
    membershipOf.mockResolvedValue({ role: "admin", company: { name: "S" } })
    await expect(verify("123456")).rejects.toThrow("redirect:/company")
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({
      email: "ana@solaris.test",
      token: "123456",
      type: "email",
    })
  })

  it("goes where the viewer was headed", async () => {
    membershipOf.mockResolvedValue({
      role: "admin",
      company: { name: "S" },
    })
    await expect(
      verify("123456", codeStep({ ...noIntent, next: "/company/people?a=1" })),
    ).rejects.toThrow("redirect:/company/people?a=1")
  })

  it("shows the no-company state only after a valid code, and ends the session", async () => {
    const state = await verify("123456")
    expect(state).toEqual({
      step: "no_company",
      email: "ana@solaris.test",
      intent: noIntent,
    })
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
    expect(redirect).not.toHaveBeenCalled()
  })

  it("explains an invite that did not apply, on the form", async () => {
    rpc.mockResolvedValue({ error: { hint: "invite_expired" } })
    expect(
      await verify("123456", codeStep({ ...noIntent, invite: "tok" })),
    ).toMatchObject({
      step: "email",
      email: "ana@solaris.test",
      error: expect.stringMatching(/expired/i),
    })
  })

  it("brings the company name back after a failed sign-up", async () => {
    rpc.mockResolvedValue({ error: { message: "boom" } })
    expect(
      await verify("123456", codeStep({ ...noIntent, company: "Solaris" })),
    ).toMatchObject({ step: "email", company: "Solaris" })
  })

  it("sends a member who opened an invite to the page that explains it", async () => {
    rpc.mockResolvedValue({ error: { hint: "invite_already_member" } })
    membershipOf.mockResolvedValue({
      role: "recipient",
      company: { name: "S" },
    })
    await expect(
      verify("123456", codeStep({ ...noIntent, invite: "tok" })),
    ).rejects.toThrow(
      "redirect:/sign-in?invite=tok&error=invite_already_member",
    )
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it("shows a retry message, not a crash, when the membership lookup fails", async () => {
    membershipOf.mockRejectedValue(new Error("lookup failed"))
    const state = await verify("123456")
    expect(state).toMatchObject({
      step: "email",
      error: expect.stringMatching(/try again/i),
    })
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it("does nothing when there is no code step to verify", async () => {
    expect(await signIn(email, form({ step: "verify", code: "123456" }))).toBe(
      email,
    )
    expect(auth.verifyOtp).not.toHaveBeenCalled()
  })
})

describe("signIn: going back", () => {
  it("returns to the email step with the email and the company name", async () => {
    const state = codeStep({ ...noIntent, company: "Solaris" })
    expect(await signIn(state, form({ step: "change" }))).toEqual({
      step: "email",
      email: "ana@solaris.test",
      company: "Solaris",
      error: null,
    })
  })

  it("leaves the no-company state for the email step", async () => {
    const state: SignInState = {
      step: "no_company",
      email: "ana@solaris.test",
      intent: noIntent,
    }
    expect(await signIn(state, form({ step: "change" }))).toMatchObject({
      step: "email",
      email: "ana@solaris.test",
      error: null,
    })
  })
})

describe("signOut", () => {
  it("ends this device's session only", async () => {
    await expect(signOut()).rejects.toThrow(/^redirect:\/$/)
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
    expect(store.delete).toHaveBeenCalledWith("cadence-demo-role")
  })

  it("leaves the browser's cookies alone when Supabase ended the session", async () => {
    await expect(signOut()).rejects.toThrow()
    expect(store.delete).toHaveBeenCalledExactlyOnceWith("cadence-demo-role")
  })

  it("still makes the browser forget the session when Supabase fails", async () => {
    auth.signOut.mockResolvedValue({ error: { message: "gotrue is down" } })
    store.getAll.mockReturnValue([
      { name: "sb-127-auth-token.0" },
      { name: "sb-127-auth-token.1" },
      { name: "theme" },
      { name: "cadence-demo-role" },
    ])
    await expect(signOut()).rejects.toThrow(/^redirect:\/$/)
    const deleted = store.delete.mock.calls.map(([name]) => name)
    expect(deleted).toContain("sb-127-auth-token.0")
    expect(deleted).toContain("sb-127-auth-token.1")
    expect(deleted).toContain("cadence-demo-role")
    expect(deleted).not.toContain("theme")
    expect(console.error).toHaveBeenCalledWith(
      "signOut failed",
      "gotrue is down",
    )
  })

  it("still goes back to the invite when Supabase fails", async () => {
    auth.signOut.mockResolvedValue({ error: { message: "down" } })
    await expect(signOut(form({ invite: "tok" }))).rejects.toThrow(
      "redirect:/sign-in?invite=tok",
    )
  })

  it("goes back to the invite when the form carries one", async () => {
    await expect(signOut(form({ invite: "tok 1" }))).rejects.toThrow(
      "redirect:/sign-in?invite=tok+1",
    )
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" })
  })

  it("ignores any other field the form carries", async () => {
    await expect(
      signOut(form({ next: "https://evil.example", company: "x" })),
    ).rejects.toThrow(/^redirect:\/$/)
  })

  it("leaves Supabase alone where it is not configured", async () => {
    config.supabaseConfigured = false
    await expect(signOut()).rejects.toThrow(/^redirect:\/$/)
    expect(auth.signOut).not.toHaveBeenCalled()
  })
})

describe("signOutEverywhere", () => {
  it("ends the account's sessions on every device", async () => {
    await expect(signOutEverywhere()).rejects.toThrow(/^redirect:\/$/)
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" })
    expect(store.delete).toHaveBeenCalledWith("cadence-demo-role")
  })

  it("still makes the browser forget the session when Supabase fails", async () => {
    auth.signOut.mockResolvedValue({ error: { message: "gotrue is down" } })
    store.getAll.mockReturnValue([{ name: "sb-127-auth-token" }])
    await expect(signOutEverywhere()).rejects.toThrow(/^redirect:\/$/)
    expect(store.delete).toHaveBeenCalledWith("sb-127-auth-token")
    expect(store.delete).toHaveBeenCalledWith("cadence-demo-role")
  })

  it("leaves Supabase alone where it is not configured, like signOut", async () => {
    config.supabaseConfigured = false
    await expect(signOutEverywhere()).rejects.toThrow(/^redirect:\/$/)
    expect(auth.signOut).not.toHaveBeenCalled()
  })
})
