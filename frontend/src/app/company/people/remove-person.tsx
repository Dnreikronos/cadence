"use client"

import { buttonVariants } from "@/components/ui/button"
import { Modal } from "@/components/ui/modal"
import { removeDescription, shortName } from "@/lib/people/display"
import { isRetryablePeopleError, peopleMessageFor } from "@/lib/people/errors"
import type { PersonRecord } from "@/lib/people/types"
import { useRemovePerson } from "@/lib/queries/people"

export function RemovePersonModal({
  person,
  onClose,
}: {
  person: PersonRecord | null
  onClose: () => void
}) {
  const remove = useRemovePerson()

  // A removal in flight keeps the dialog, so its outcome is never missed.
  function handleOpenChange(open: boolean) {
    if (open || remove.isPending) return
    remove.reset()
    onClose()
  }

  return (
    <Modal
      open={person !== null}
      onOpenChange={handleOpenChange}
      title={person ? `Remove ${shortName(person.name)}?` : "Remove person"}
      description={person ? removeDescription(person.activation) : undefined}
    >
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
            remove.mutate(person, { onSuccess: onClose })
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
