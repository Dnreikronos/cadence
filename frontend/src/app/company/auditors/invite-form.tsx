"use client"

import { useState } from "react"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { messageFor } from "@/lib/api"
import { auditorSchema } from "@/lib/auditors/schema"
import { canRetry, useInviteAuditor } from "@/lib/queries/auditors"
import { cn } from "@/lib/utils"

export function InviteAuditorModal({
  open,
  onOpenChange,
  finalFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus?: () => HTMLElement | boolean
}) {
  const invite = useInviteAuditor()
  const [email, setEmail] = useState("")
  const [validation, setValidation] = useState<string | undefined>(undefined)

  // The request cannot be cancelled, so the dialog stays until it answers and the
  // admin sees how it went. The toast on success is the hook's, not this component's.
  function change(next: boolean) {
    if (invite.isPending) return
    if (!next) {
      invite.reset()
      setEmail("")
      setValidation(undefined)
    }
    onOpenChange(next)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (invite.isPending) return
    const parsed = auditorSchema.safeParse({ email })
    if (!parsed.success) {
      setValidation(parsed.error.issues[0].message)
      return
    }
    invite.mutate(parsed.data.email, { onSuccess: () => change(false) })
  }

  const error =
    validation ?? (invite.isError ? messageFor(invite.error) : undefined)
  const retryable = invite.isError && canRetry(invite.error)

  return (
    <Modal
      open={open}
      onOpenChange={change}
      finalFocus={finalFocus}
      title="Invite an auditor"
      description="They will read every payment amount of your company. They need no wallet."
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label
            htmlFor="auditor-email"
            className="mb-1.5 block text-ui font-medium text-ink"
          >
            Email
          </label>
          <input
            id="auditor-email"
            type="email"
            autoFocus
            autoComplete="off"
            readOnly={invite.isPending}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
              setValidation(undefined)
              if (invite.isError) invite.reset()
            }}
            aria-invalid={!!error}
            aria-describedby={error ? "auditor-email-error" : undefined}
            className={cn(fieldClass, "h-9")}
          />
          {error && (
            <p
              id="auditor-email-error"
              role="alert"
              className="mt-1 text-caption text-danger-fg"
            >
              {error}
            </p>
          )}
        </div>
        <p className="text-caption/normal text-ink-muted">
          Cadence can read amounts too, and logs every read.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={invite.isPending}
            onClick={() => change(false)}
            className={buttonVariants({ variant: "secondary" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={invite.isPending}
            className={buttonVariants()}
          >
            {invite.isPending
              ? "Sending…"
              : retryable
                ? "Try again"
                : "Send invite"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
