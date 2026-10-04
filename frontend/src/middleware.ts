import { NextResponse, type NextRequest } from "next/server"
import { guard, requiredRole, type Role } from "@/lib/auth/guard"
import { isDemoEnabled } from "@/lib/demo/mode"
import { DEMO_COOKIE, parseDemoRole } from "@/lib/demo/viewer"
import { membershipOf } from "@/lib/supabase/membership"
import { createMiddlewareClient } from "@/lib/supabase/middleware"

export async function middleware(request: NextRequest) {
  // Demo configuration has no Supabase to ask: the cookie is the session.
  if (await isDemoEnabled()) {
    const role = parseDemoRole(request.cookies.get(DEMO_COOKIE)?.value)
    return decide(request, role, NextResponse.next())
  }
  const guarded = requiredRole(request.nextUrl.pathname) !== null
  let session: ReturnType<typeof createMiddlewareClient>
  try {
    session = createMiddlewareClient(request)
  } catch (error) {
    // Without Supabase configured nobody can sign in: fail closed on guarded areas only.
    if (!guarded) return NextResponse.next()
    console.error(error)
    return decide(request, null, NextResponse.next())
  }

  // getUser() revalidates the token with Supabase Auth and refreshes the cookie.
  const { data } = await session.supabase.auth.getUser()
  if (!data.user) {
    return decide(request, null, session.response(), session.cacheHeaders)
  }
  let role: Role
  try {
    const membership = await membershipOf(session.supabase, data.user.id)
    if (!membership) {
      // Every session belongs to a company; one without (e.g. removed) is ended here.
      await session.supabase.auth.signOut()
      return redirect(
        request,
        "/sign-in?error=no_company",
        session.response(),
        session.cacheHeaders,
      )
    }
    role = membership.role
  } catch (error) {
    console.error(error)
    return decide(request, null, session.response(), session.cacheHeaders)
  }
  return decide(request, role, session.response(), session.cacheHeaders)
}

function decide(
  request: NextRequest,
  role: Role | null,
  response: NextResponse,
  cacheHeaders: Record<string, string> = {},
) {
  const decision = guard(request.nextUrl.pathname, role)
  if (decision.kind === "next") return response
  return redirect(request, decision.to, response, cacheHeaders)
}

// Carry refreshed session cookies and their no-store headers across the redirect.
function redirect(
  request: NextRequest,
  to: string,
  response: NextResponse,
  cacheHeaders: Record<string, string>,
) {
  const redirect = NextResponse.redirect(new URL(to, request.url), {
    headers: cacheHeaders,
  })
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie)
  return redirect
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
