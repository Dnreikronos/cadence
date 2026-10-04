import { redirect } from "next/navigation"
import { readIntent } from "@/lib/auth/complete-sign-in"
import { safeNext } from "@/lib/auth/guard"
import { signedInView } from "@/lib/auth/signed-in-view"
import { signInErrorMessage } from "@/lib/auth/sign-in-errors"
import { currentViewer, type CurrentViewer } from "@/lib/auth/viewer"
import { isDemoEnabled } from "@/lib/demo/mode"
import { AlreadyMember } from "./already-member"
import { ClearQueryCache } from "./clear-query-cache"
import { DemoPanel } from "./demo-panel"
import { EmailCodeForm } from "./email-code-form"
import { readSearchParams, type AuthSearchParams } from "./search-params"

export type { AuthSearchParams }

export async function AuthPage({
  mode,
  searchParams,
}: {
  mode: "sign-in" | "sign-up"
  searchParams: AuthSearchParams
}) {
  const params = await readSearchParams(searchParams)
  const intent = readIntent(params)
  const demoEnabled = await isDemoEnabled()
  // A failed membership lookup is not "signed out": the form stays, with a way to retry.
  let viewer: CurrentViewer | null = null
  let lookupFailed = false
  try {
    viewer = await currentViewer()
  } catch (error) {
    console.error("viewer lookup failed", error)
    lookupFailed = true
  }
  if (viewer) {
    // A member who opened an invite is told why it cannot be used rather than dropped. The demo
    // viewer has no invites: it keeps going straight to its area.
    const view = signedInView({
      invite: intent.invite,
      error: params.get("error"),
      demo: demoEnabled,
    })
    if (view === "already_member") {
      return (
        <>
          <ClearQueryCache />
          <AlreadyMember viewer={viewer} invite={intent.invite} />
        </>
      )
    }
    // Every session belongs to a company, so a signed-in visitor goes straight to it.
    redirect(safeNext(intent.next, viewer.membership.role))
  }
  // Without Supabase there is no code to email: the demo is the way in.
  const demo = mode === "sign-in" && demoEnabled
  const retry = new URLSearchParams(params)
  retry.delete("error")
  return (
    <>
      <ClearQueryCache />
      {demo ? (
        <DemoPanel next={intent.next} />
      ) : (
        <EmailCodeForm
          mode={mode}
          intent={intent}
          noCompany={mode === "sign-in" && params.get("error") === "no_company"}
          error={
            lookupFailed
              ? signInErrorMessage("lookup_failed")
              : signInErrorMessage(params.get("error"))
          }
          retryHref={lookupFailed ? `/${mode}?${retry}` : null}
        />
      )}
    </>
  )
}
