"use server"

import type { AuthError } from "@supabase/supabase-js"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { isDemoEnabled } from "@/lib/demo/mode"
import { DEMO_COOKIE } from "@/lib/demo/viewer"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"
import {
  completeSignIn,
  intentParams,
  readIntent,
  type SignInIntent,
} from "./complete-sign-in"
import { signInErrorMessage, type SignInError } from "./sign-in-errors"

// React resets the form after an action, so the email step gets back what was typed.
// The code step keeps the intent read at the email step, so sign-up's company name survives it.
// `no_company` is a valid code from an email that belongs to no company: the only place that says so.
export type SignInState =
  | { step: "email"; email?: string; company?: string; error?: string | null }
  | { step: "code"; email: string; intent: SignInIntent; error?: string }
  | { step: "no_company"; email?: string; intent: SignInIntent }

const email = z.email()
const code = z.string().regex(/^\d{6}$/)
const companyName = z.string().trim().min(1).max(200)

// One action for both steps, so the form keeps a single state; `step` says which button was pressed.
export async function signIn(
  state: SignInState,
  form: FormData,
): Promise<SignInState> {
  const step = form.get("step")
  if (step === "change") return backToEmail(state, null)
  // Without Supabase there is no code to send or check: the form says so, and nothing
  // reaches the client (which would throw for want of its URL).
  if (!isSupabaseConfigured()) {
    return backToEmail(state, signInErrorMessage("not_configured"))
  }
  if (step === "verify") return verifyCode(state, form)
  return sendCode(state, form)
}

function backToEmail(state: SignInState, error: string | null): SignInState {
  if (state.step === "email") return { ...state, error }
  return {
    step: "email",
    email: state.email,
    company: state.intent.company ?? undefined,
    error,
  }
}

async function sendCode(
  state: SignInState,
  form: FormData,
): Promise<SignInState> {
  // "Send a new code" posts from the code step, where the intent already lives in the state.
  const intent = state.step === "code" ? state.intent : readIntent(form)
  const typed = String(form.get("email") ?? "").trim()
  const fail = (error: string | null): SignInState => ({
    step: "email",
    email: typed,
    company: intent.company ?? undefined,
    error,
  })
  const address = email.safeParse(typed)
  if (!address.success) return fail("Enter a valid email.")
  if (form.has("company") && !companyName.safeParse(intent.company).success) {
    return fail("Enter your company's name.")
  }
  // The emailed link lands on /auth/confirm carrying the same intent.
  // Supabase only sends links to allowlisted URLs, so a forged Origin cannot redirect elsewhere.
  const origin = (await headers()).get("origin")
  if (!origin) return fail(signInErrorMessage("send_failed"))
  const confirm = new URL("/auth/confirm", origin)
  // The email template appends `&token_hash=…` to this URL, so it always needs a query.
  confirm.search = intentParams({
    ...intent,
    next: intent.next ?? "/",
  }).toString()
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email: address.data,
    options: {
      // Accounts are only made to join a company: by invite, or by creating one.
      shouldCreateUser: Boolean(intent.invite || intent.company),
      emailRedirectTo: confirm.toString(),
    },
  })
  const failure = error && sendFailure(error)
  if (failure) return fail(signInErrorMessage(failure))
  return { step: "code", email: address.data, intent }
}

function sendFailure(error: AuthError): SignInError | null {
  // Raised when the email has no account and this sign-in may not create one. Saying so
  // would tell anyone which emails have accounts: the code step shows regardless, and a
  // missing company is only told after a valid code.
  if (error.code === "otp_disabled") return null
  // Supabase applies the per-address email frequency limit only to addresses that have an
  // account, so a second request for a known email would answer 429 where an unknown one
  // answers `otp_disabled`. Both must look the same: the code step, whose hint already tells
  // the person to check their inbox and spam folder. Only the per-IP limit says "too many".
  if (error.code === "over_email_send_rate_limit") return null
  console.error("signInWithOtp failed", error.message)
  return error.code === "over_request_rate_limit"
    ? "too_many_attempts"
    : "send_failed"
}

async function verifyCode(
  state: SignInState,
  form: FormData,
): Promise<SignInState> {
  if (state.step !== "code") return state
  const token = code.safeParse(String(form.get("code") ?? "").trim())
  if (!token.success) return { ...state, error: "Enter the 6-digit code." }
  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({
    email: state.email,
    token: token.data,
    type: "email",
  })
  if (error) return { ...state, error: "That code is wrong or has expired." }
  const outcome = await completeSignIn(supabase, state.intent)
  if ("error" in outcome) {
    if (outcome.error === "no_company") {
      return { step: "no_company", email: state.email, intent: state.intent }
    }
    return backToEmail(state, signInErrorMessage(outcome.error))
  }
  redirect(outcome.to)
}

// `invite` (a hidden field of the "already a member" page) sends the viewer back to that
// invite once signed out, to use it with another account.
// Signing out here must not end the viewer's sessions elsewhere: this device only.
export async function signOut(form?: FormData) {
  return endSession("local", form)
}

// The user menu's "Sign out of all devices".
export async function signOutEverywhere() {
  return endSession("global")
}

async function endSession(scope: "local" | "global", form?: FormData) {
  // The demo viewer has no Supabase session: its cookie is all there is to end.
  const store = await cookies()
  store.delete(DEMO_COOKIE)
  if (!isSupabaseConfigured())
    redirect((await isDemoEnabled()) ? "/sign-in" : "/")
  const supabase = await createClient()
  const { error } = await supabase.auth.signOut({ scope })
  if (error) {
    // Supabase could not end the session, so this browser must still forget it.
    console.error("signOut failed", error.message)
    for (const { name } of store.getAll()) {
      if (name.startsWith("sb-")) store.delete(name)
    }
  }
  const invite = form && readIntent(form).invite
  redirect(
    invite
      ? `/sign-in?${intentParams({ invite, company: null, next: null })}`
      : "/",
  )
}
