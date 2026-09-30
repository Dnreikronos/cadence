import { NextResponse, type NextRequest } from "next/server";
import { guard, requiredRole, type Role, type Viewer } from "@/lib/auth/guard";
import { createMiddlewareClient } from "@/lib/supabase/middleware";

const signedOut: Viewer = { signedIn: false, roles: [] };

export async function middleware(request: NextRequest) {
  const guarded = requiredRole(request.nextUrl.pathname) !== null;
  let session: ReturnType<typeof createMiddlewareClient>;
  try {
    session = createMiddlewareClient(request);
  } catch (error) {
    // Without Supabase configured nobody can sign in: fail closed on guarded areas only.
    if (!guarded) return NextResponse.next();
    console.error(error);
    return decide(request, signedOut, NextResponse.next());
  }

  // getUser() revalidates the token with Supabase Auth and refreshes the cookie.
  const { data } = await session.supabase.auth.getUser();
  const user = data.user;
  let viewer: Viewer = signedOut;
  if (user) {
    viewer = { signedIn: true, roles: guarded ? await rolesOf(session.supabase, user.id) : [] };
  }
  return decide(request, viewer, session.response(), session.cacheHeaders);
}

// Contract with the memberships table (#75); RLS lets a user read their own rows.
async function rolesOf(
  supabase: ReturnType<typeof createMiddlewareClient>["supabase"],
  userId: string,
): Promise<Role[]> {
  const { data, error } = await supabase.from("memberships").select("role").eq("user_id", userId);
  if (error) console.error("memberships lookup failed", error.message);
  return (data ?? []).map((row: { role: Role }) => row.role);
}

function decide(
  request: NextRequest,
  viewer: Viewer,
  response: NextResponse,
  cacheHeaders: Record<string, string> = {},
) {
  const decision = guard(request.nextUrl.pathname, viewer);
  if (decision.kind === "next") return response;
  // Carry refreshed session cookies and their no-store headers across the redirect.
  const redirect = NextResponse.redirect(new URL(decision.to, request.url), {
    headers: cacheHeaders,
  });
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
