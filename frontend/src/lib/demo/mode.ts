import { isSupabaseConfigured } from "@/lib/supabase/env"
import { demoAllowed } from "./allowed"

// Read per call, so the rules apply to this request's configuration. The API mode
// and the cluster throw at import when their env is bad, and the middleware runs on
// public pages too: a bad value must turn the demo off, not take every page down.
export async function isDemoEnabled(): Promise<boolean> {
  try {
    const [{ apiConfig }, { cluster }] = await Promise.all([
      import("@/lib/api/mode"),
      import("@/lib/solana/cluster"),
    ])
    return demoAllowed({
      mode: apiConfig.mode,
      supabaseConfigured: isSupabaseConfigured(),
      isMainnet: cluster.isMainnet,
    })
  } catch {
    return false
  }
}
