"use server"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { safeNext, type Role } from "@/lib/auth/guard"
import { isHttpsRequest } from "./cookie"
import { isDemoEnabled } from "./mode"
import { DEMO_COOKIE, parseDemoRole } from "./viewer"

// A session cookie, so closing the browser ends the demo.
export async function signInAsDemo(form: FormData) {
  await startDemo(parseDemoRole(form.get("role")), form.get("next"))
}

// A recipient who has set nothing up: /activate resets the mock's setup state once.
export async function signInAsNewRecipient() {
  await startDemo("recipient", "/activate?fresh=1")
}

async function startDemo(role: Role | null, next: FormDataEntryValue | null) {
  if (!(await isDemoEnabled()) || !role) redirect("/sign-in")
  const store = await cookies()
  store.set(DEMO_COOKIE, role, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(await headers()),
    path: "/",
  })
  redirect(safeNext(typeof next === "string" ? next : null, role))
}
