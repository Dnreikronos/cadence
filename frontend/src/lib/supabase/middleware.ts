import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { cookieOptions, isHttps, withSessionLifetime } from "./cookie-options"
import { supabaseEnv } from "./env"

// Refreshes the session cookie on every request and exposes the client to the caller.
export function createMiddlewareClient(request: NextRequest) {
  const { url, publishableKey } = supabaseEnv()
  let response = NextResponse.next({ request })
  // A response that sets a session cookie must never be cached and served to someone else.
  const cacheHeaders: Record<string, string> = {}
  const secure = isHttps(
    request.nextUrl.protocol,
    request.headers.get("x-forwarded-proto"),
  )
  const supabase = createServerClient(url, publishableKey, {
    cookieOptions: cookieOptions(secure),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        Object.assign(cacheHeaders, headers)
        for (const { name, value } of cookiesToSet)
          request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of withSessionLifetime(
          cookiesToSet,
        )) {
          response.cookies.set(name, value, options)
        }
        for (const [key, value] of Object.entries(cacheHeaders))
          response.headers.set(key, value)
      },
    },
  })
  return { supabase, response: () => response, cacheHeaders }
}
