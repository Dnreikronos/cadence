import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"
import {
  completeSignIn,
  intentParams,
  readIntent,
} from "@/lib/auth/complete-sign-in"
import { createClient } from "@/lib/supabase/server"

// The emailed link: token_hash works in any browser, unlike a PKCE code bound to the one that asked.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const intent = readIntent(params)
  // Errors go back to the form the viewer started from.
  const form = intent.company ? "/sign-up" : "/sign-in"
  const back = (query: URLSearchParams) =>
    NextResponse.redirect(new URL(`${form}?${query}`, request.url))

  const tokenHash = params.get("token_hash")
  const supabase = await createClient()
  const { error } = tokenHash
    ? await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: (params.get("type") ?? "email") as EmailOtpType,
      })
    : { error: true }
  if (error) {
    const retry = intentParams(intent)
    retry.set("error", "link_expired")
    return back(retry)
  }
  const outcome = await completeSignIn(supabase, intent)
  if ("error" in outcome) {
    return back(new URLSearchParams({ error: outcome.error }))
  }
  return NextResponse.redirect(new URL(outcome.to, request.url))
}
