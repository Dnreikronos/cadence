import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { intentParams, readIntent } from "@/lib/auth/complete-sign-in"
import { buttonVariants } from "@/components/ui/button"
import { readSearchParams, type AuthSearchParams } from "../../search-params"

// The emailed link has to be safe to open without side effects: mail scanners fetch it before
// the person does, and the token inside works once. So this page only shows a button, and
// the button posts to /auth/confirm/verify, which is what spends the token.
export const metadata: Metadata = {
  title: "Confirm sign-in",
  robots: { index: false },
  // Not "no-referrer": Chrome then sends `Origin: null` with the form's POST, which the verify
  // route refuses. Same-origin still keeps the token out of any Referer sent to other sites.
  referrer: "same-origin",
}

export default async function Confirm({
  searchParams,
}: {
  searchParams: AuthSearchParams
}) {
  const params = await readSearchParams(searchParams)
  const intent = readIntent(params)
  const tokenHash = params.get("token_hash")
  if (!tokenHash) {
    const query = intentParams(intent)
    query.set("error", "link_expired")
    redirect(`${intent.company ? "/sign-up" : "/sign-in"}?${query}`)
  }
  const action = intent.company
    ? "Create your company"
    : intent.invite
      ? "Accept your invite"
      : "Sign in to Cadence"

  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
        {action}
      </h1>
      <p className="mt-2 text-ui/normal text-ink-muted">
        One more step: confirm that you opened this link. We ask so an email
        scanner cannot use it up before you do.
      </p>
      <form
        method="post"
        action="/auth/confirm/verify"
        className="mt-5 space-y-3"
      >
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input
          type="hidden"
          name="type"
          value={params.get("type") ?? "email"}
        />
        {intent.next && <input type="hidden" name="next" value={intent.next} />}
        {intent.invite && (
          <input type="hidden" name="invite" value={intent.invite} />
        )}
        {intent.company && (
          <input type="hidden" name="company" value={intent.company} />
        )}
        <button
          type="submit"
          autoFocus
          className={buttonVariants({ className: "w-full" })}
        >
          Continue
        </button>
      </form>
    </div>
  )
}
