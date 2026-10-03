import type { ServerClient } from "@/lib/supabase/server"
import { membershipOf } from "@/lib/supabase/membership"
import { safeNext } from "./guard"
import { inviteFailure, type SignInError } from "./sign-in-errors"

// What a sign-in is for: joining by invite, signing up by creating a company, or just returning.
export type SignInIntent = {
  invite: string | null
  company: string | null
  next: string | null
}

export type SignInOutcome = { to: string } | { error: SignInError }

// Both verification paths (code and link) end here. Every session must belong to a company:
// when this one does not, it is signed out again and the error is shown on the form.
export async function completeSignIn(
  supabase: ServerClient,
  { invite, company, next }: SignInIntent,
): Promise<SignInOutcome> {
  const { data } = await supabase.auth.getUser()
  if (!data.user) return { error: "sign_in_failed" }
  let failure: SignInError | null = null
  if (invite) failure = await acceptInvite(supabase, invite)
  else if (company) failure = await createCompany(supabase, company)
  const membership = await membershipOf(supabase, data.user.id)
  // A member reopening a used invite, or signing up twice, simply carries on to their area.
  if (membership) return { to: safeNext(next, membership.role) }
  await supabase.auth.signOut()
  return { error: failure ?? "no_company" }
}

async function acceptInvite(supabase: ServerClient, invite: string) {
  const { error } = await supabase.rpc("accept_invite", { p_token: invite })
  return error && inviteFailure(error.hint)
}

async function createCompany(supabase: ServerClient, name: string) {
  const { error } = await supabase.rpc("create_company", { p_name: name })
  if (error) console.error("create_company failed", error.message)
  return error && ("company_failed" as const)
}

// The intent rides along every sign-in step as query params or form fields.
export function readIntent(source: {
  get(name: string): FormDataEntryValue | null
}): SignInIntent {
  const text = (name: string) => {
    const value = source.get(name)
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  return {
    invite: text("invite"),
    company: text("company"),
    next: text("next"),
  }
}

export function intentParams({ invite, company, next }: SignInIntent) {
  const params = new URLSearchParams()
  if (next) params.set("next", next)
  if (invite) params.set("invite", invite)
  if (company) params.set("company", company)
  return params
}
