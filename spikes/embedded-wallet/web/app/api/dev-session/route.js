import { supabaseAdmin } from "../../lib"

// SPIKE ONLY, NEVER DEPLOY. This route is unauthenticated and uses the Supabase service
// role to mint a sign-in link for an email address. It stands in for the email-code
// sign-in on a local Supabase with throwaway `@cadence.test` users. It refuses to run in
// production, and it only accepts test addresses, but neither makes it safe to expose.
export async function POST(request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 })

  let email
  try {
    ;({ email } = await request.json())
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 })
  }
  if (typeof email !== "string" || email.length > 254 || !email.endsWith("@cadence.test")) {
    return Response.json({ error: "bad_request" }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "magiclink", email })
  if (error) {
    console.error("dev-session: generateLink failed:", error.message)
    return Response.json({ error: "dev_session_failed" }, { status: 500 })
  }
  return Response.json({ token_hash: data.properties.hashed_token, type: data.properties.verification_type })
}
