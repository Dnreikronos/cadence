import type { CookieOptions, CookieOptionsWithName } from "@supabase/ssr"

// The session cookie lasts a week. `@supabase/ssr` defaults to 400 days, far past
// anything the product needs; the cookie is rewritten whenever the session is refreshed,
// so an active person is not signed out.
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60

// One definition for the server, browser and middleware clients, so they cannot drift:
// the three of them read and rewrite the same cookies.
//
// Not httpOnly: the browser client reads the session (`getSession()` in `lib/api`) to
// send the token to the proof service, so script has to see the cookie. Taking it out of
// reach of script needs a same-origin BFF that adds the token itself.
//
// `Secure` follows the request: https in production, and left off on http://localhost
// and *.localhost, where development and the e2e suite run (a browser drops a Secure
// cookie that arrives over plain http on a host it does not treat as local).
//
// `maxAge` is here for completeness only: the library overwrites it with its own 400
// days on every write, so `withSessionLifetime` is what actually shortens it.
export function cookieOptions(secure: boolean): CookieOptionsWithName {
  return { path: "/", sameSite: "lax", secure, maxAge: SESSION_MAX_AGE }
}

// A cookie being deleted (`maxAge` 0) stays deleted; anything else lives at most a week.
export function capMaxAge(options: CookieOptions): CookieOptions {
  const { maxAge } = options
  if (maxAge !== undefined && maxAge <= 0) return options
  return {
    ...options,
    maxAge: Math.min(maxAge ?? SESSION_MAX_AGE, SESSION_MAX_AGE),
  }
}

type SetCookie = { name: string; value: string; options: CookieOptions }

// For the `setAll` of each client, which receives the library's options, 400 days
// included: puts the shorter lifetime on every cookie before it is written.
export function withSessionLifetime<T extends SetCookie>(cookies: T[]): T[] {
  return cookies.map((cookie) => ({
    ...cookie,
    options: capMaxAge(cookie.options),
  }))
}

// Whether a request reached the app over https. `forwardedProto` is the value of
// X-Forwarded-Proto: the first entry is the client's hop when proxies append their own.
// Spoofing it only changes whether the sender's own cookie is marked Secure.
export function isHttps(
  protocol: string | null | undefined,
  forwardedProto?: string | null,
): boolean {
  const forwarded = forwardedProto?.split(",")[0]?.trim().toLowerCase()
  if (forwarded) return forwarded === "https"
  return protocol?.replace(/:$/, "").toLowerCase() === "https"
}
