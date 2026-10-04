"use client"

import { useRef, useState } from "react"
import { Mail, Pencil, Plus, Trash2, Users } from "lucide-react"
import { ActivationPill } from "@/components/ui/activation-pill"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ApiErrorState } from "@/components/ui/api-error-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { unitsToUsd } from "@/lib/money"
import { PeopleNotConfiguredError } from "@/lib/people/errors"
import { MAX_PEOPLE } from "@/lib/people/paging"
import { useInviteStale } from "@/lib/people/stale-invites"
import { kindLabels, type PersonRecord } from "@/lib/people/types"
import {
  amountsView,
  currentAmount,
  hasActiveAuditor,
  summarize,
  type AmountsView,
} from "@/lib/people/view"
import { useAuditors } from "@/lib/queries/auditors"
import {
  usePeople,
  usePersonAmounts,
  useSendInvite,
} from "@/lib/queries/people"
import { useRestoreFocus } from "@/lib/restore-focus"
import { PersonFormModal } from "./person-form"
import { RemovePersonModal } from "./remove-person"

// A row grid on wide screens; on narrow ones the cells wrap under the name.
const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_88px_128px_128px_196px] md:items-center md:gap-x-4"

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; person: PersonRecord }
  | { kind: "remove"; person: PersonRecord }

export function PeopleScreen() {
  const people = usePeople()
  const amountsQuery = usePersonAmounts()
  const auditors = useAuditors()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  // Closing returns focus to the button that opened the dialog, or to "Add person"
  // when that row or button is gone.
  const restore = useRestoreFocus(() => addRef.current)
  const close = () => setDialog(null)
  const openDialog = (next: Dialog) => {
    restore.remember()
    setDialog(next)
  }

  // Amounts already read stay on screen when a refresh fails, marked as stale.
  const amounts = amountsView(amountsQuery)
  // Unknown (loading or failed) reads as the longer sentence, never "no auditor".
  const hasAuditor = hasActiveAuditor(auditors.data)

  const addButton = (
    <button
      ref={addRef}
      type="button"
      onClick={() => openDialog({ kind: "add" })}
      className={buttonVariants()}
    >
      <Plus className="size-4" />
      Add person
    </button>
  )

  if (people.isPending) return <PeopleSkeleton />
  if (people.isError && people.error instanceof PeopleNotConfiguredError) {
    return (
      <ErrorState
        title="Sign-in is not configured"
        description="This deployment has no Supabase project, so your people can't be read."
      />
    )
  }
  if (people.isError) {
    return (
      <ErrorState
        title="Couldn't load your people"
        description="Check your connection and try again."
        onRetry={() => people.refetch()}
      />
    )
  }

  const list = people.data.people
  const { total, missing } = summarize(list, amounts)

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
              <WhoCanSee viewerRole="admin" hasAuditor={hasAuditor} />
              {missing > 0 && (
                <span className="basis-full text-caption sm:basis-auto">
                  · {missing} without an amount
                </span>
              )}
            </p>
            {addButton}
          </div>

          {people.data.truncated && (
            <p role="status" className="text-ui/normal text-ink-muted">
              Showing the first {MAX_PEOPLE.toLocaleString("en-US")} people. The
              rest aren&apos;t listed here, and the total only counts these.
            </p>
          )}

          {amounts.state === "error" && (
            <ApiErrorState
              error={amountsQuery.error}
              title="Couldn't load the monthly amounts"
              description="Your people are shown below. Try again to see what each is paid."
              onRetry={() => amountsQuery.refetch()}
            />
          )}
          {amounts.state === "stale" && (
            <ApiErrorState
              error={amountsQuery.error}
              title="Couldn't refresh the monthly amounts"
              description="The amounts below may be out of date. Try again to refresh them."
              onRetry={() => amountsQuery.refetch()}
            />
          )}
          {(amounts.state === "ready" || amounts.state === "stale") &&
            amounts.truncated && (
              <p role="status" className="text-ui/normal text-ink-muted">
                Some amounts weren&apos;t loaded because the list is long, so
                they show as not loaded and the total may be short.
              </p>
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
                  onEdit={() => openDialog({ kind: "edit", person })}
                  onRemove={() => openDialog({ kind: "remove", person })}
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
          dialog?.kind === "edit"
            ? currentAmount(amounts, amountsQuery.isFetching, dialog.person.id)
            : { known: false }
        }
        hasAuditor={hasAuditor}
        open={dialog?.kind === "add" || dialog?.kind === "edit"}
        onOpenChange={(open) => !open && close()}
        finalFocus={restore.finalFocus}
      />
      <RemovePersonModal
        person={dialog?.kind === "remove" ? dialog.person : null}
        onClose={close}
        // The row that opened the dialog is gone: focus goes to "Add person".
        onRemoved={restore.originRemoved}
        finalFocus={restore.finalFocus}
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
  amounts: AmountsView
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
    amounts.state === "ready" || amounts.state === "stale"
      ? amounts.byPerson[person.id]
      : undefined
  const inviteText = invite.isPending
    ? "Sending…"
    : inviteVerb[person.activation]
  const inviteStale = useInviteStale(person.id)
  const hasInvite =
    person.activation === "invited" || person.activation === "invite-expired"

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
      {amountsKnown(amounts) && units === undefined ? (
        <span className="text-ui text-ink-muted">
          {amounts.truncated ? "Not loaded" : "Not set"}
        </span>
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
        {inviteStale && hasInvite && (
          <span className="mt-1 block text-caption text-warning-fg">
            Email changed: the old link won&apos;t work
          </span>
        )}
      </span>
      <span className="ml-auto flex items-center gap-1 md:ml-0 md:justify-end">
        {!isActive && (
          <button
            type="button"
            // Not `disabled`: that would drop focus to the page while the invite goes out.
            aria-disabled={invite.isPending}
            onClick={() => !invite.isPending && invite.mutate(person)}
            // Starts with the visible text, so voice control can say it (WCAG 2.5.3).
            aria-label={`${inviteText}, ${person.name}`}
            className={buttonVariants({
              variant: "secondary",
              size: "sm",
              className:
                "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            })}
          >
            <Mail className="size-3.5" />
            {inviteText}
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

function amountsKnown(
  view: AmountsView,
): view is Extract<AmountsView, { state: "ready" | "stale" }> {
  return view.state === "ready" || view.state === "stale"
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
