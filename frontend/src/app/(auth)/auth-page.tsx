import { redirect } from "next/navigation"
import { readIntent } from "@/lib/auth/complete-sign-in"
import { safeNext } from "@/lib/auth/guard"
import { signInErrorMessage } from "@/lib/auth/sign-in-errors"
import { currentViewer } from "@/lib/auth/viewer"
import { EmailCodeForm } from "./email-code-form"

export type AuthSearchParams = Promise<
  Record<string, string | string[] | undefined>
>

export async function AuthPage({
  mode,
  searchParams,
}: {
  mode: "sign-in" | "sign-up"
  searchParams: AuthSearchParams
}) {
  const params = new URLSearchParams(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  )
  const intent = readIntent(params)
  // Every session belongs to a company, so a signed-in visitor goes straight to it.
  const viewer = await currentViewer()
  if (viewer) redirect(safeNext(intent.next, viewer.membership.role))
  return (
    <EmailCodeForm
      mode={mode}
      intent={intent}
      error={signInErrorMessage(params.get("error"))}
    />
  )
}
