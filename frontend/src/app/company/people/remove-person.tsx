"use client"

import { useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { Modal } from "@/components/ui/modal"
import { removeDescription, shortName } from "@/lib/people/display"
import { isRetryablePeopleError, peopleMessageFor } from "@/lib/people/errors"
import type { PersonRecord } from "@/lib/people/types"
import { useRemovePerson } from "@/lib/queries/people"

export function RemovePersonModal({
  person,
  onClose,
  onRemoved,
  finalFocus,
}: {
  person: PersonRecord | null
  onClose: () => void
  // The row the dialog came from is gone, so focus has nowhere to return to.
  onRemoved: () => void
  finalFocus?: () => HTMLElement | boolean
}) {
  const remove = useRemovePerson()
  const [blocked, setBlocked] = useState(false)

  // A removal in flight keeps the dialog, so its outcome is never missed: a try
  // to close it says so instead of doing nothing.
  function handleOpenChange(open: boolean) {
    if (open) return
    if (remove.isPending) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    remove.reset()
    onClose()
  }

  return (
    <Modal
      open={person !== null}
      onOpenChange={handleOpenChange}
      finalFocus={finalFocus}
      title={person ? `Remove ${shortName(person.name)}?` : "Remove person"}
      description={person ? removeDescription(person.activation) : undefined}
    >
      {blocked && remove.isPending && (
        <p role="status" className="mb-4 text-ui/normal text-ink-muted">
          Still removing. This closes when it&apos;s done.
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="mb-4 text-ui/normal text-danger-fg">
          {peopleMessageFor(remove.error)}
          {isRetryablePeopleError(remove.error) && " You can try again."}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => handleOpenChange(false)}
          className={buttonVariants({ variant: "secondary" })}
        >
          Keep
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (!person) return
            remove.mutate(person, {
              onSuccess: () => {
                setBlocked(false)
                onRemoved()
                onClose()
              },
            })
          }}
          className={buttonVariants({
            className: "bg-danger-fg text-white hover:bg-danger-fg/90",
          })}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  )
}
