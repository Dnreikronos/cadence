import { NextResponse, type NextRequest } from "next/server"
import { cleanSearch, guard, requiredRole, type Role } from "@/lib/auth/guard"
import { isDemoEnabled } from "@/lib/demo/mode"
import { isDevPath } from "@/lib/dev-tools"
import { devToolsOff } from "@/lib/dev-tools-env"
import { DEMO_COOKIE, parseDemoRole } from "@/lib/demo/viewer"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { membershipOf } from "@/lib/supabase/membership"
import { createMiddlewareClient } from "@/lib/supabase/middleware"

export async function middleware(request: NextRequest) {
  // The /dev pages need no session, so they are shut here before anything else runs:
  // a 404 for the app's own not-found page, whatever the path's spelling.
  if (isDevPath(request.nextUrl.pathname) && devToolsOff()) {
    return NextResponse.rewrite(new URL("/dev-tools-are-off", request.url), {
      status: 404,
    })
  }
  // Demo configuration has no Supabase to ask: the cookie is the session.
  if (await isDemoEnabled()) {
    const role = parseDemoRole(request.cookies.get(DEMO_COOKIE)?.value)
    return decide(request, role, NextResponse.next())
  }
  const guarded = requiredRole(request.nextUrl.pathname) !== null
  // Without Supabase configured nobody can sign in: fail closed on guarded areas only,
  // quietly (this is every request, and the configuration is not news to anyone).
  if (!isSupabaseConfigured()) {
    return guarded
      ? decide(request, null, NextResponse.next())
      : NextResponse.next()
  }
  let session: ReturnType<typeof createMiddlewareClient>
  try {
    session = createMiddlewareClient(request)
  } catch (error) {
    // Configured, yet the client could not be made: fail closed on guarded areas.
    if (!guarded) return NextResponse.next()
    console.error(error instanceof Error ? error.name : typeof error)
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
      // Already where the redirect leads: ending the session again, or redirecting to
      // here once more, could loop if the logout keeps failing while getUser works.
      const { pathname, searchParams } = request.nextUrl
      if (pathname === "/sign-in" && searchParams.get("error") === "no_company")
        return session.response()
      // Every session belongs to a company; one without (e.g. removed) is ended here.
      // This device only: other sessions of the same user are not ours to end.
      const { error } = await session.supabase.auth.signOut({ scope: "local" })
      if (error) console.error("signOut failed", error.message)
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
  const decision = guard(
    request.nextUrl.pathname,
    role,
    cleanSearch(request.nextUrl.search),
  )
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
