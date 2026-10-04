"use client"

import { AmountDisplay } from "@/components/ui/amount-display"
import { buttonVariants } from "@/components/ui/button"
import { Modal } from "@/components/ui/modal"
import { unitsToUsd } from "@/lib/money"
import { payLabel, type PayrollPerson } from "@/lib/runs/plan"

// The one confirmation before anything is created. It cannot be dismissed while the run
// is being created (the caller ignores `onOpenChange(false)` then), and it closes itself
// from the caller's success path, so a result is never lost with the dialog.
export function ConfirmRunDialog({
  open,
  onOpenChange,
  recipients,
  total,
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipients: readonly PayrollPerson[]
  total: string
  pending: boolean
  error: string | null
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={payLabel(recipients.length, total)}
      description="Each payment is encrypted on-chain, so the public can't read the amounts. You, each recipient, any auditor you invited and Cadence can."
    >
      <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {recipients.map((person) => (
          <li
            key={person.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-ui"
          >
            <span className="min-w-0 wrap-break-word text-ink">
              {person.name}
            </span>
            <AmountDisplay amount={unitsToUsd(person.amount ?? "0")} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-caption/normal text-ink-muted">
        Your wallet signs each payment in turn. Keep this page open until they
        are all confirmed.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-ui/normal text-danger-fg">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => onOpenChange(false)}
          className={buttonVariants({ variant: "secondary" })}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className={buttonVariants()}
        >
          {pending ? "Preparing…" : error ? "Try again" : "Confirm and sign"}
        </button>
      </div>
    </Modal>
  )
}
