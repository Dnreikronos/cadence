"use client"

import Link from "next/link"
import { useActionState } from "react"
import { signIn, type SignInState } from "@/lib/auth/actions"
import type { SignInIntent } from "@/lib/auth/complete-sign-in"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"

const field = `h-10 ${fieldClass}`
const quiet = "text-ui text-ink-muted hover:text-ink"

// Sign-in and sign-up share one flow: email → 6-digit code; sign-up also names the company.
export function EmailCodeForm({
  mode,
  intent,
  error,
}: {
  mode: "sign-in" | "sign-up"
  intent: SignInIntent
  error: string | null
}) {
  const [state, action, isPending] = useActionState<SignInState, FormData>(
    signIn,
    { step: "email", error },
  )
  const title =
    mode === "sign-up"
      ? "Create your company"
      : intent.invite
        ? "Accept your invite"
        : "Sign in to Cadence"

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
            <span className="font-medium text-ink">{state.email}</span>. Enter
            it below, or open the link in the email.
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
