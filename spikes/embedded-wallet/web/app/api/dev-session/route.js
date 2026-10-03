import { supabaseAdmin } from "../../lib"

// Spike only: stands in for the email-code sign-in by minting a one-time link for a test user.
export async function POST(request) {
  const { email } = await request.json()
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "magiclink", email })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ token_hash: data.properties.hashed_token, type: data.properties.verification_type })
}
