"use client"

import { Building2 } from "lucide-react"
import Link from "next/link"
import { useActionState } from "react"
import { signIn, type SignInState } from "@/lib/auth/actions"
import type { SignInIntent } from "@/lib/auth/complete-sign-in"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { fieldClass } from "@/components/ui/field"

const field = `h-10 ${fieldClass}`
const quiet = "text-ui text-ink-muted hover:text-ink"

// Sign-in and sign-up share one flow: email → 6-digit code; sign-up also names the company.
export function EmailCodeForm({
  mode,
  intent,
  error,
  noCompany,
  retryHref,
}: {
  mode: "sign-in" | "sign-up"
  intent: SignInIntent
  error: string | null
  // Arrived with a session that belongs to no company (the middleware ended it).
  noCompany: boolean
  // Set when the account lookup failed: the form stays, with a way to try again.
  retryHref: string | null
}) {
  const [state, action, isPending] = useActionState<SignInState, FormData>(
    signIn,
    noCompany
      ? { step: "no_company", intent }
      : // The company name survives an expired link: the sign-up form comes back filled in.
        { step: "email", company: intent.company ?? undefined, error },
  )
  const title =
    mode === "sign-up"
      ? "Create your company"
      : intent.invite
        ? "Accept your invite"
        : "Sign in to Cadence"

  if (state.step === "no_company") {
    return (
      <NoCompany email={state.email} action={action} isPending={isPending} />
    )
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>

      {state.step === "email" ? (
        <form action={action} className="mt-5 space-y-3">
          <p className="text-ui/normal text-ink-muted">
            {mode === "sign-up"
              ? "You will be its admin. We will email you a 6-digit code to confirm your address."
              : "We will email you a 6-digit code. No password needed."}
          </p>
          <IntentFields intent={intent} />
          {mode === "sign-up" && (
            <label className="block space-y-1.5">
              <span className="text-label text-ink-muted">Company name</span>
              <input
                name="company"
                required
                maxLength={200}
                autoComplete="organization"
                autoFocus
                defaultValue={state.company}
                className={field}
              />
            </label>
          )}
          <label className="block space-y-1.5">
            <span className="text-label text-ink-muted">Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus={mode === "sign-in"}
              defaultValue={state.email}
              className={field}
            />
          </label>
          <FormError message={state.error} />
          {retryHref && (
            <Link href={retryHref} className="block text-ui text-ink underline">
              Try again
            </Link>
          )}
          <button
            type="submit"
            disabled={isPending}
            className={buttonVariants({ className: "w-full" })}
          >
            {isPending ? "Sending…" : "Email me a code"}
          </button>
          <p className="pt-1 text-center text-ui text-ink-muted">
            {mode === "sign-up" ? (
              <>
                Already on Cadence?{" "}
                <Link href="/sign-in" className="text-ink underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New company?{" "}
                <Link href="/sign-up" className="text-ink underline">
                  Create yours
                </Link>
              </>
            )}
          </p>
        </form>
      ) : (
        <form action={action} className="mt-5 space-y-3">
          <p className="text-ui/normal text-ink-muted">
            We sent a code to{" "}
            <span className="font-medium break-all text-ink">
              {state.email}
            </span>
            . Enter it below, or open the link in the email.
          </p>
          <p className="text-ui/normal text-ink-muted">
            Nothing after a minute? Check the address. If you have no account
            yet, create a company or open your invite link.
          </p>
          <label className="block space-y-1.5">
            <span className="text-label text-ink-muted">Code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              className={`${field} font-mono tracking-[0.3em]`}
            />
          </label>
          <FormError message={state.error} />
          <input type="hidden" name="email" value={state.email} />
          <button
            type="submit"
            name="step"
            value="verify"
            disabled={isPending}
            className={buttonVariants({ className: "w-full" })}
          >
            {isPending
              ? "Checking…"
              : mode === "sign-up"
                ? "Create company"
                : "Sign in"}
          </button>
          <div className="flex justify-between">
            <button
              type="submit"
              name="step"
              value="send"
              formNoValidate
              disabled={isPending}
              className={quiet}
            >
              Send a new code
            </button>
            <button
              type="submit"
              name="step"
              value="change"
              formNoValidate
              disabled={isPending}
              className={quiet}
            >
              Use another email
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

// A valid code from an email with no company. The session is already ended, so the way on
// is a different email, or a company of one's own.
function NoCompany({
  email,
  action,
  isPending,
}: {
  email?: string
  action: (form: FormData) => void
  isPending: boolean
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-card">
      <h1 className="sr-only">Sign in to Cadence</h1>
      <EmptyState
        icon={Building2}
        title="No company on this email"
        description={`${email ?? "This email"} is not part of a company on Cadence, and you are signed out. Companies are created on the sign-up page; recipients and auditors join with the invite their company emailed them.`}
        className="min-w-0 border-0 wrap-break-word"
        action={
          <form action={action} className="flex flex-col gap-2">
            <Link
              href="/sign-up"
              className={buttonVariants({ className: "w-full" })}
            >
              Create a company
            </Link>
            <button
              type="submit"
              name="step"
              value="change"
              disabled={isPending}
              className={buttonVariants({
                variant: "secondary",
                className: "w-full",
              })}
            >
              Sign in with another email
            </button>
          </form>
        }
      />
    </div>
  )
}

function IntentFields({ intent }: { intent: SignInIntent }) {
  return (
    <>
      {intent.next && <input type="hidden" name="next" value={intent.next} />}
      {intent.invite && (
        <input type="hidden" name="invite" value={intent.invite} />
      )}
    </>
  )
}

function FormError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-ui text-danger-fg">
      {message}
    </p>
  )
}
