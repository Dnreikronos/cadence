"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { auditorSchema } from "@/lib/auditors/schema"
import { useInviteAuditor } from "@/lib/auditors/queries"
import { cn } from "@/lib/utils"

export function InviteAuditorModal({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Invite an auditor"
      description="They see every payment amount. They need no wallet."
    >
      {open && <InviteForm onDone={() => onOpenChange(false)} />}
    </Modal>
  )
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const invite = useInviteAuditor()
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = auditorSchema.safeParse({ email })
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    invite.mutate(parsed.data.email, {
      onSuccess: () => {
        toast.success(`Invite sent to ${parsed.data.email}`)
        onDone()
      },
      onError: (error) => setError(error.message),
    })
  }

  return (
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
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setError(undefined)
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
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDone}
          className={buttonVariants({ variant: "secondary" })}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={invite.isPending}
          className={buttonVariants()}
        >
          {invite.isPending ? "Sending…" : "Send invite"}
        </button>
      </div>
    </form>
  )
}
