"use server"

import type { AuthError } from "@supabase/supabase-js"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
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
export type SignInState =
  | { step: "email"; email?: string; company?: string; error?: string | null }
  | { step: "code"; email: string; intent: SignInIntent; error?: string }

const email = z.email()
const code = z.string().regex(/^\d{6}$/)
const companyName = z.string().trim().min(1).max(200)

// One action for both steps, so the form keeps a single state; `step` says which button was pressed.
export async function signIn(
  state: SignInState,
  form: FormData,
): Promise<SignInState> {
  const step = form.get("step")
  if (step === "verify") return verifyCode(state, form)
  if (step === "change") return backToEmail(state, null)
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
  if (error) return fail(signInErrorMessage(sendFailure(error)))
  return { step: "code", email: address.data, intent }
}

function sendFailure(error: AuthError): SignInError {
  // Raised when the email has no account and this sign-in may not create one.
  if (error.code === "otp_disabled") return "no_company"
  console.error("signInWithOtp failed", error.message)
  return error.status === 429 ? "too_many_attempts" : "send_failed"
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
    return backToEmail(state, signInErrorMessage(outcome.error))
  }
  redirect(outcome.to)
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/")
}
