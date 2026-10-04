import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"
import { isDemoEnabled } from "@/lib/demo/mode"
import { DEMO_COOKIE, parseDemoRole, demoViewer } from "@/lib/demo/viewer"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"
import { membershipOf, type Membership } from "@/lib/supabase/membership"
import { homeFor, type Role } from "./guard"

export type CurrentViewer = { email: string; membership: Membership }

// The signed-in member for this request, or null; read once per render.
// The middleware ends any session without a membership, so there is no third state.
export const currentViewer = cache(async (): Promise<CurrentViewer | null> => {
  // The demo viewer stands in for a sign-in only where the demo is enabled.
  if (await isDemoEnabled()) {
    const role = parseDemoRole((await cookies()).get(DEMO_COOKIE)?.value)
    return role && demoViewer(role)
  }
  // Without Supabase configured nobody is signed in; public pages still render.
  if (!isSupabaseConfigured()) return null
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return null
  const membership = await membershipOf(supabase, data.user.id)
  return membership && { email: data.user.email ?? "", membership }
})

// For a role's area: the middleware already guards it; this keeps the layout honest on its own.
export async function requireMember(role: Role) {
  const viewer = await currentViewer()
  if (!viewer) redirect("/sign-in")
  if (viewer.membership.role !== role) redirect(homeFor(viewer.membership.role))
  return viewer
}
