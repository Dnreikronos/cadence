import { createBrowserClient } from "@supabase/ssr"
import { supabaseEnv } from "./env"

let client: ReturnType<typeof createBrowserClient> | undefined

// One client per tab, so every caller sees the same refreshed session.
export function browserSupabase() {
  if (!client) {
    const { url, publishableKey } = supabaseEnv()
    client = createBrowserClient(url, publishableKey)
  }
  return client
}
