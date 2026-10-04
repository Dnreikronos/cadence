import Link from "next/link"
import { signOut } from "@/lib/auth/actions"
import { homeFor } from "@/lib/auth/guard"
import type { CurrentViewer } from "@/lib/auth/viewer"
import { roleLabels } from "@/components/app/nav"
import { buttonVariants } from "@/components/ui/button"

// A member opened an invite: an account belongs to one company, so the invite cannot be used with it.
export function AlreadyMember({
  viewer,
  invite,
}: {
  viewer: CurrentViewer
  invite: string | null
}) {
  const { role, company } = viewer.membership
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
        You already belong to a company
      </h1>
      <p className="mt-2 text-ui/normal text-ink-muted">
        You are signed in as{" "}
        <span className="font-medium break-all text-ink">{viewer.email}</span>,{" "}
        {roleLabels[role].toLowerCase()} at{" "}
        <span className="font-medium wrap-break-word text-ink">
          {company.name}
        </span>
        . An account belongs to one company, so this invite cannot be added to
        it.
      </p>
      <p className="mt-2 text-ui/normal text-ink-muted">
        {invite
          ? "To use the invite, sign out and open it with the email it was sent to."
          : "To use an invite, sign out and open its link with the email it was sent to."}
      </p>
      <div className="mt-5 flex flex-col gap-2">
        <Link
          href={homeFor(role)}
          className={buttonVariants({ className: "w-full" })}
        >
          Continue to {company.name}
        </Link>
        <form action={signOut}>
          {invite && <input type="hidden" name="invite" value={invite} />}
          <button
            type="submit"
            className={buttonVariants({
              variant: "secondary",
              className: "w-full",
            })}
          >
            Sign out to use the invite
          </button>
        </form>
      </div>
    </div>
  )
}
