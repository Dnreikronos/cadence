"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { safeNext } from "@/lib/auth/guard"
import { isDemoEnabled } from "./mode"
import { DEMO_COOKIE, parseDemoRole } from "./viewer"

// A session cookie, so closing the browser ends the demo.
export async function signInAsDemo(form: FormData) {
  const role = parseDemoRole(form.get("role"))
  if (!isDemoEnabled() || !role) redirect("/sign-in")
  const store = await cookies()
  store.set(DEMO_COOKIE, role, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  })
  const next = form.get("next")
  redirect(safeNext(typeof next === "string" ? next : null, role))
}
