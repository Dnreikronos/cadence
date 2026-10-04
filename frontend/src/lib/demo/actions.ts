"use server"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { safeNext } from "@/lib/auth/guard"
import { isHttpsRequest } from "./cookie"
import { isDemoEnabled } from "./mode"
import { DEMO_COOKIE, parseDemoRole } from "./viewer"

// A session cookie, so closing the browser ends the demo.
export async function signInAsDemo(form: FormData) {
  const role = parseDemoRole(form.get("role"))
  if (!(await isDemoEnabled()) || !role) redirect("/sign-in")
  const store = await cookies()
  store.set(DEMO_COOKIE, role, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(await headers()),
    path: "/",
  })
  const next = form.get("next")
  redirect(safeNext(typeof next === "string" ? next : null, role))
}
