import { NextResponse, type NextRequest } from "next/server"
import {
  completeSignIn,
  intentParams,
  readIntent,
} from "@/lib/auth/complete-sign-in"
import { confirmType, isSameOrigin } from "@/lib/auth/confirm-link"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"

// These responses carry or follow a session: no cache may keep or replay them.
const noStore = { "cache-control": "no-store" }

// The confirm page's form lands here. Verifying spends the one-time token, which is why
// it takes a POST: a mail scanner that only opens the link never reaches this route.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers, request.nextUrl.protocol)) {
    return new NextResponse(null, { status: 403, headers: noStore })
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    // Not a form post (wrong content type, broken body): nothing of ours sent it.
    return new NextResponse(null, { status: 400, headers: noStore })
  }
  const intent = readIntent(form)
  // Errors go back to the form the viewer started from, with what they had typed in the intent.
  const path = intent.company ? "/sign-up" : "/sign-in"
  // 303 turns the POST into a GET; the default 307 would replay it on the next page. The
  // location stays relative, so it follows whatever host the browser used (behind a proxy,
  // request.url may name the server's own).
  const to = (target: string) =>
    new NextResponse(null, {
      status: 303,
      headers: { location: target, ...noStore },
    })
  const back = (error: string) => {
    const query = intentParams(intent)
    query.set("error", error)
    return to(`${path}?${query}`)
  }

  // Without Supabase nothing can be verified: say so on the form, not with a 500.
  if (!isSupabaseConfigured()) return back("not_configured")
  const tokenHash = form.get("token_hash")
  const type = confirmType(form.get("type"))
  if (typeof tokenHash !== "string" || !tokenHash || !type) {
    return back("link_expired")
  }
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    })
    if (error) return back("link_expired")
    const outcome = await completeSignIn(supabase, intent)
    return "error" in outcome ? back(outcome.error) : to(outcome.to)
  } catch (error) {
    // Supabase unreachable or a lookup that threw: the person goes back to the form, never
    // to an error page. Only the kind of error is logged, never what it carried.
    console.error(
      "confirm verify failed",
      error instanceof Error ? error.name : typeof error,
    )
    return back("sign_in_failed")
  }
}
