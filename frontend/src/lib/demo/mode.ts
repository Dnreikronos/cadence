import { apiConfig } from "@/lib/api/mode"
import { cluster } from "@/lib/solana/cluster"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { demoAllowed } from "./allowed"

// Read per call, so the rules apply to this request's configuration.
export function isDemoEnabled(): boolean {
  return demoAllowed({
    mode: apiConfig.mode,
    supabaseConfigured: isSupabaseConfigured(),
    isMainnet: cluster.isMainnet,
  })
}
