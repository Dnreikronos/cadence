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

// A proxy may append to these headers ("a.test, 10.0.0.1"): the first value is the client's.
const first = (value: string | null) => value?.split(",")[0].trim() || null

// A POST that signs someone in must come from our own confirm page: a form on another site
// could otherwise sign a visitor into the attacker's account (login CSRF). Browsers always
// send Origin on a cross-site POST. The scheme, host and port must all match: behind a proxy
// the public host and scheme are in x-forwarded-host and x-forwarded-proto, and `protocol`
// (like "https:") is the one the server itself saw.
export function isSameOrigin(headers: Headers, protocol: string) {
  const origin = headers.get("origin")
  const host = first(headers.get("x-forwarded-host")) ?? headers.get("host")
  const scheme = first(headers.get("x-forwarded-proto")) ?? protocol
  if (!origin || !host) return false
  try {
    const sent = new URL(origin)
    // Through URL, so "a.test:443" and "a.test" are the same https host.
    const expected = new URL(`${scheme.replace(/:$/, "")}://${host}`)
    return sent.protocol === expected.protocol && sent.host === expected.host
  } catch {
    return false
  }
}
