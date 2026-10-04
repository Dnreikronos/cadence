"use client"

import { useState } from "react"
import { Mail, Pencil, Plus, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Modal } from "@/components/ui/modal"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { usePeople, useRemovePerson, useSendInvite } from "@/lib/people/queries"
import { kindLabels, type Person } from "@/lib/people/types"
import { ActivationPill } from "@/components/ui/activation-pill"
import { PersonFormModal } from "./person-form"

// A row grid on wide screens; on narrow ones the cells wrap under the name.
const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_88px_128px_128px_196px] md:items-center md:gap-x-4"

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; person: Person }
  | { kind: "remove"; person: Person }

export function PeopleScreen() {
  const people = usePeople()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = () => setDialog(null)

  const addButton = (
    <button
      type="button"
      onClick={() => setDialog({ kind: "add" })}
      className={buttonVariants()}
    >
      <Plus className="size-4" />
      Add person
    </button>
  )

  if (people.isPending) return <PeopleSkeleton />
  if (people.isError) {
    return (
      <ErrorState
        title="Couldn't load your people"
        description="Check your connection and try again."
        onRetry={() => people.refetch()}
      />
    )
  }

  const list = people.data
  const monthlyTotal = list.reduce((sum, p) => sum + p.monthlyAmount, 0)

  return (
    <>
      {list.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No one on the list yet"
          description="Add the people you pay. They get an invite to set up a private account."
          action={addButton}
        />
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-ui text-ink-muted">
              {list.length} {list.length === 1 ? "person" : "people"}
              <span aria-hidden>·</span>
              <AmountDisplay amount={monthlyTotal} className="text-ink" />
              per month
              <WhoCanSee viewerRole="admin" hasAuditor={false} />
            </p>
            {addButton}
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div
              className={`hidden border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${rowColumns}`}
            >
              <span>Name</span>
              <span>Kind</span>
              <span>Monthly</span>
              <span>Status</span>
              <span className="sr-only">Actions</span>
            </div>
            <ul>
              {list.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  onEdit={() => setDialog({ kind: "edit", person })}
                  onRemove={() => setDialog({ kind: "remove", person })}
                />
              ))}
            </ul>
          </div>
        </section>
      )}

      <PersonFormModal
        // Key on the target so edit state never leaks between people.
        key={dialog?.kind === "edit" ? dialog.person.id : "add"}
        person={dialog?.kind === "edit" ? dialog.person : undefined}
        open={dialog?.kind === "add" || dialog?.kind === "edit"}
        onOpenChange={(open) => !open && close()}
      />
      <RemoveModal
        person={dialog?.kind === "remove" ? dialog.person : null}
        onClose={close}
      />
    </>
  )
}

function PersonRow({
  person,
  onEdit,
  onRemove,
}: {
  person: Person
  onEdit: () => void
  onRemove: () => void
}) {
  const invite = useSendInvite()
  const isActive = person.activation === "active"
  const initials = person.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase()

  function sendInvite() {
    invite.mutate(person.id, {
      onSuccess: () => toast.success(`Invite sent to ${person.email}`),
      onError: (error) => toast.error(error.message),
    })
  }

  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0 md:grid ${rowColumns}`}
    >
      <span className="flex min-w-0 basis-full items-center gap-2.5 md:basis-auto">
        <AvatarPerson initials={initials} size={30} />
        <span className="min-w-0">
          <span className="block truncate text-ui font-medium text-ink">
            {person.name}
          </span>
          <span className="block truncate text-caption text-ink-muted">
            {person.email}
          </span>
        </span>
      </span>
      <span className="text-ui text-ink-muted">{kindLabels[person.kind]}</span>
      <AmountDisplay amount={person.monthlyAmount} className="text-ui" />
      <span>
        <ActivationPill activation={person.activation} />
      </span>
      <span className="ml-auto flex items-center gap-1 md:ml-0 md:justify-end">
        {!isActive && (
          <button
            type="button"
            onClick={sendInvite}
            disabled={invite.isPending}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Mail className="size-3.5" />
            {person.activation === "not-invited" ? "Send invite" : "Resend"}
          </button>
        )}
        <IconButton label={`Edit ${person.name}`} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton label={`Remove ${person.name}`} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </li>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
    >
      {children}
    </button>
  )
}

function RemoveModal({
  person,
  onClose,
}: {
  person: Person | null
  onClose: () => void
}) {
  const remove = useRemovePerson()
  return (
    <Modal
      open={person !== null}
      onOpenChange={(open) => !open && onClose()}
      title={person ? `Remove ${person.name}?` : "Remove person"}
      description="Removal is final. They stop appearing in new payroll runs, and you can't undo it."
    >
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className={buttonVariants({ variant: "secondary" })}
        >
          Keep
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (!person) return
            remove.mutate(person.id, {
              onSuccess: () => {
                toast.success(`${person.name} removed`)
                onClose()
              },
              onError: (error) => toast.error(error.message),
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

function PeopleSkeleton() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <span className="sr-only">Loading people</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
        >
          <Skeleton className="size-7.5 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      ))}
    </div>
  )
}
