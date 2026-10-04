"use client"

import { useState } from "react"
import { Mail, Pencil, Plus, Trash2, Users } from "lucide-react"
import { ActivationPill } from "@/components/ui/activation-pill"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { sumUnits, unitsToUsd } from "@/lib/money"
import {
  usePeople,
  usePersonAmounts,
  useSendInvite,
} from "@/lib/queries/people"
import { kindLabels, type PersonRecord } from "@/lib/people/types"
import { PersonFormModal } from "./person-form"
import { RemovePersonModal } from "./remove-person"

// A row grid on wide screens; on narrow ones the cells wrap under the name.
const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_88px_128px_128px_196px] md:items-center md:gap-x-4"

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; person: PersonRecord }
  | { kind: "remove"; person: PersonRecord }

type Amounts =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; byPerson: Record<string, string> }

export function PeopleScreen() {
  const people = usePeople()
  const amountsQuery = usePersonAmounts()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = () => setDialog(null)

  // Amounts already read stay on screen when a refresh fails.
  const amounts: Amounts = amountsQuery.data
    ? { state: "ready", byPerson: amountsQuery.data }
    : amountsQuery.isError
      ? { state: "error" }
      : { state: "loading" }

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
  const withAmount = list.filter(
    (person) => amounts.state === "ready" && person.id in amounts.byPerson,
  )
  const total =
    amounts.state === "ready"
      ? sumUnits(withAmount.map((person) => amounts.byPerson[person.id]))
      : undefined
  const missing =
    amounts.state === "ready" ? list.length - withAmount.length : 0

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
            <p className="flex flex-wrap items-center gap-x-1.5 text-ui text-ink-muted">
              {list.length} {list.length === 1 ? "person" : "people"}
              <span aria-hidden>·</span>
              <AmountDisplay
                amount={total === undefined ? undefined : unitsToUsd(total)}
                state={
                  total !== undefined
                    ? "revealed"
                    : amounts.state === "error"
                      ? "hidden"
                      : "loading"
                }
                className="text-ink"
              />
              per month
              <WhoCanSee viewerRole="admin" hasAuditor={false} />
              {missing > 0 && (
                <span className="basis-full text-caption sm:basis-auto">
                  · {missing} without an amount
                </span>
              )}
            </p>
            {addButton}
          </div>

          {amounts.state === "error" && (
            <ErrorState
              title="Couldn't load the monthly amounts"
              description="Your people are shown below. Try again to see what each is paid."
              onRetry={() => amountsQuery.refetch()}
            />
          )}

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
                  amounts={amounts}
                  onEdit={() => setDialog({ kind: "edit", person })}
                  onRemove={() => setDialog({ kind: "remove", person })}
                />
              ))}
            </ul>
          </div>

          <p className="text-caption/normal text-ink-muted">
            Monthly amounts are held encrypted by the payment service, not in
            the people list. Cadence can read them to prove payments, and so can
            any auditor you invite.
          </p>
        </section>
      )}

      <PersonFormModal
        // Key on the target so edit state never leaks between people.
        key={dialog?.kind === "edit" ? dialog.person.id : "add"}
        person={dialog?.kind === "edit" ? dialog.person : undefined}
        amount={
          dialog?.kind === "edit" && amounts.state === "ready"
            ? { known: true, units: amounts.byPerson[dialog.person.id] }
            : { known: false }
        }
        open={dialog?.kind === "add" || dialog?.kind === "edit"}
        onOpenChange={(open) => !open && close()}
      />
      <RemovePersonModal
        person={dialog?.kind === "remove" ? dialog.person : null}
        onClose={close}
      />
    </>
  )
}

function PersonRow({
  person,
  amounts,
  onEdit,
  onRemove,
}: {
  person: PersonRecord
  amounts: Amounts
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
  const units =
    amounts.state === "ready" ? amounts.byPerson[person.id] : undefined

  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0 md:grid ${rowColumns}`}
    >
      <span className="flex min-w-0 basis-full items-center gap-2.5 md:basis-auto">
        <AvatarPerson initials={initials} size={30} />
        <span className="min-w-0">
          <span className="block text-ui font-medium wrap-break-word text-ink">
            {person.name}
          </span>
          <span className="block text-caption break-all text-ink-muted">
            {person.email}
          </span>
        </span>
      </span>
      <span className="text-ui text-ink-muted">{kindLabels[person.kind]}</span>
      {amounts.state === "ready" && units === undefined ? (
        <span className="text-ui text-ink-muted">Not set</span>
      ) : (
        <AmountDisplay
          amount={units === undefined ? undefined : unitsToUsd(units)}
          state={
            units !== undefined
              ? "revealed"
              : amounts.state === "error"
                ? "hidden"
                : "loading"
          }
          className="text-ui"
        />
      )}
      <span>
        <ActivationPill activation={person.activation} />
      </span>
      <span className="ml-auto flex items-center gap-1 md:ml-0 md:justify-end">
        {!isActive && (
          <button
            type="button"
            onClick={() => invite.mutate(person)}
            disabled={invite.isPending}
            aria-label={`${inviteLabel[person.activation]} ${person.name}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Mail className="size-3.5" />
            {invite.isPending ? "Sending…" : inviteVerb[person.activation]}
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

const inviteVerb = {
  active: "",
  invited: "Resend",
  "invite-expired": "Invite again",
  "not-invited": "Send invite",
} as const

const inviteLabel = {
  active: "",
  invited: "Resend the invite to",
  "invite-expired": "Send a new invite to",
  "not-invited": "Send an invite to",
} as const

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
