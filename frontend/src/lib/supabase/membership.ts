import type { SupabaseClient } from "@supabase/supabase-js"
import type { Role } from "@/lib/auth/guard"

export type Membership = { role: Role; company: { name: string } }

// Contract with the memberships table (#75): one row per user, readable by its owner under RLS.
export async function membershipOf(
  supabase: SupabaseClient,
  userId: string,
): Promise<Membership | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role, company:companies(name)")
    .eq("user_id", userId)
    .maybeSingle<Membership>()
  // A failed lookup is not "no membership": callers must not sign anyone out over it.
  if (error) throw new Error(`memberships lookup failed: ${error.message}`)
  return data
}
