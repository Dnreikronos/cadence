import type { EmailOtpType } from "@supabase/supabase-js"

// The email templates only ever write these two: `signup` for a new account, `email` otherwise.
const confirmTypes: readonly EmailOtpType[] = ["email", "signup"]

// The `type` param is user-controlled: anything outside the templates' two values is no link of ours.
export function confirmType(value: FormDataEntryValue | null) {
  return typeof value === "string" &&
    (confirmTypes as readonly string[]).includes(value)
    ? (value as EmailOtpType)
    : null
}

// A POST that signs someone in must come from our own confirm page: a form on another site
// could otherwise sign a visitor into the attacker's account (login CSRF). Browsers always
// send Origin on a cross-site POST; behind a proxy the public host is in x-forwarded-host.
export function isSameOrigin(headers: Headers) {
  const origin = headers.get("origin")
  const host = headers.get("x-forwarded-host") ?? headers.get("host")
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
