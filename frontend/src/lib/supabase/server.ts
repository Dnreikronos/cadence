import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { supabaseEnv } from "./env"

// For server components, server actions and route handlers; the session lives in cookies.
export async function createClient() {
  const { url, publishableKey } = supabaseEnv()
  const cookieStore = await cookies()
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet)
            cookieStore.set(name, value, options)
        } catch {
          // Server components cannot write cookies; the middleware refreshes the session instead.
        }
      },
    },
  })
}

export type ServerClient = Awaited<ReturnType<typeof createClient>>
