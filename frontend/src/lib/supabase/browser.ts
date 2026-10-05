import { createBrowserClient } from "@supabase/ssr"
import { browserCookies } from "./browser-cookies"
import { cookieOptions, isHttps } from "./cookie-options"
import { supabaseEnv } from "./env"

let client: ReturnType<typeof createBrowserClient> | undefined

// One client per tab, so every caller sees the same refreshed session.
export function browserSupabase() {
  if (!client) {
    const { url, publishableKey } = supabaseEnv()
    client = createBrowserClient(url, publishableKey, {
      cookies: browserCookies,
      cookieOptions: cookieOptions(
        isHttps(
          typeof window === "undefined" ? null : window.location.protocol,
        ),
      ),
    })
  }
  return client
}
