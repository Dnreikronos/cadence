import { redirect } from "next/navigation"
import { readIntent } from "@/lib/auth/complete-sign-in"
import { safeNext } from "@/lib/auth/guard"
import { signInErrorMessage } from "@/lib/auth/sign-in-errors"
import { currentViewer } from "@/lib/auth/viewer"
import { isDemoEnabled } from "@/lib/demo/mode"
import { DemoPanel } from "./demo-panel"
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
  // Without Supabase there is no code to email: the demo is the way in.
  if (mode === "sign-in" && isDemoEnabled()) {
    return <DemoPanel next={intent.next} />
  }
  return (
    <EmailCodeForm
      mode={mode}
      intent={intent}
      error={signInErrorMessage(params.get("error"))}
    />
  )
}
