import type { CookieOptions } from "@supabase/ssr"
import { withSessionLifetime } from "./cookie-options"

// The browser client's own `document.cookie` handling, replaced only so that the cookies
// it writes get the week-long lifetime: the library gives its default storage no way to
// shorten the 400 days it writes (see `withSessionLifetime`). Same wire format as the
// library's: URI-encoded values, one `name=value; attributes` string per cookie.

export function parseCookies(
  header: string,
): { name: string; value: string }[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=")
      const name = at === -1 ? part : part.slice(0, at)
      const raw = at === -1 ? "" : part.slice(at + 1)
      try {
        return { name, value: decodeURIComponent(raw) }
      } catch {
        return { name, value: raw }
      }
    })
}

const sameSite = { lax: "Lax", strict: "Strict", none: "None" } as const

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined)
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.httpOnly) parts.push("HttpOnly")
  if (options.secure) parts.push("Secure")
  if (typeof options.sameSite === "string") {
    parts.push(`SameSite=${sameSite[options.sameSite]}`)
  } else if (options.sameSite) {
    parts.push("SameSite=Strict")
  }
  return parts.join("; ")
}

// `cookies` for createBrowserClient. Outside a browser (the people repository's tests,
// a pre-render) there is no cookie jar: nothing to read, nothing written.
export const browserCookies = {
  getAll() {
    if (typeof document === "undefined") return []
    return parseCookies(document.cookie)
  },
  setAll(cookies: { name: string; value: string; options: CookieOptions }[]) {
    if (typeof document === "undefined") return
    for (const { name, value, options } of withSessionLifetime(cookies)) {
      document.cookie = serializeCookie(name, value, options)
    }
  },
}
