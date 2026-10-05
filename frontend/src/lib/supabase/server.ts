import { createServerClient } from "@supabase/ssr"
import { cookies, headers } from "next/headers"
import {
  cookieOptions,
  isHttpsRequest,
  withSessionLifetime,
} from "./cookie-options"
import { supabaseEnv } from "./env"

// For server components, server actions and route handlers; the session lives in cookies.
export async function createClient() {
  const { url, publishableKey } = supabaseEnv()
  const cookieStore = await cookies()
  const secure = isHttpsRequest(await headers())
  return createServerClient(url, publishableKey, {
    cookieOptions: cookieOptions(secure),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of withSessionLifetime(
            cookiesToSet,
          ))
            cookieStore.set(name, value, options)
        } catch {
          // Server components cannot write cookies; the middleware refreshes the session instead.
        }
      },
    },
  })
}

export type ServerClient = Awaited<ReturnType<typeof createClient>>
