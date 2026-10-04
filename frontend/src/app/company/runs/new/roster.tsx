"use client"

import Link from "next/link"
import { useId } from "react"
import { Check, Mail, TriangleAlert } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { AvatarPerson } from "@/components/ui/avatar-person"
import { buttonVariants } from "@/components/ui/button"
import { unitsToUsd } from "@/lib/money"
import { initialsOf } from "@/lib/runs/people"
import {
  excludedNote,
  kindLabels,
  type Excluded,
  type PayrollPerson,
} from "@/lib/runs/plan"

// The people who can be paid, each with a checkbox. Everyone starts ticked.
export function PayableList({
  payable,
  unticked,
  onToggle,
  onToggleAll,
  disabled,
}: {
  payable: readonly PayrollPerson[]
  unticked: ReadonlySet<string>
  onToggle: (id: string) => void
  onToggleAll: (selectAll: boolean) => void
  disabled: boolean
}) {
  const selected = payable.length - unticked.size
  const all = selected === payable.length
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <label className="flex min-h-11 items-center gap-3 border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase">
        <input
          type="checkbox"
          checked={all}
          disabled={disabled}
          ref={(input) => {
            if (input) input.indeterminate = selected > 0 && !all
          }}
          onChange={() => onToggleAll(!all)}
          className="size-4 shrink-0 accent-ink"
        />
        Everyone ({payable.length})
      </label>
      <ul>
        {payable.map((person) => (
          <PayableRow
            key={person.id}
            person={person}
            ticked={!unticked.has(person.id)}
            disabled={disabled}
            onToggle={() => onToggle(person.id)}
          />
        ))}
      </ul>
    </div>
  )
}

function PayableRow({
  person,
  ticked,
  disabled,
  onToggle,
}: {
  person: PayrollPerson
  ticked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const id = useId()
  return (
    <li className="border-b border-line last:border-0">
      <label
        htmlFor={id}
        className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 has-disabled:cursor-default"
      >
        <input
          id={id}
          type="checkbox"
          checked={ticked}
          disabled={disabled}
          onChange={onToggle}
          className="size-4 shrink-0 accent-ink"
        />
        <span aria-hidden>
          <AvatarPerson initials={initialsOf(person.name)} size={30} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium wrap-break-word text-ink">
            {person.name}
          </span>
          <span className="block text-caption text-ink-muted">
            {kindLabels[person.kind]} ·{" "}
            <span className="break-all">{person.email}</span>
          </span>
        </span>
        <AmountDisplay
          amount={unitsToUsd(person.amount ?? "0")}
          className={ticked ? "text-ui" : "text-ui text-ink-muted"}
        />
      </label>
    </li>
  )
}

// People a run cannot pay yet, with what to do about it.
export function ExcludedList({
  excluded,
  invited,
  inviting,
  onInvite,
}: {
  excluded: readonly Excluded[]
  // Ids invited during this visit.
  invited: ReadonlySet<string>
  inviting: boolean
  onInvite: (person: PayrollPerson) => void
}) {
  return (
    <section
      aria-labelledby="excluded-heading"
      className="rounded-xl border border-warning-border bg-warning-bg p-4"
    >
      <h2
        id="excluded-heading"
        className="flex items-center gap-2 text-ui font-medium text-warning-fg"
      >
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        Left out of this run ({excluded.length})
      </h2>
      <p className="mt-1 text-ui/normal text-warning-fg">
        A payment needs an account to land in, so these people can&apos;t be
        paid yet. Pay everyone else now and include them in a later run.
      </p>
      <ul className="mt-3 divide-y divide-warning-border rounded-lg border border-warning-border bg-surface">
        {excluded.map((item) => (
          <ExcludedRow
            key={item.person.id}
            item={item}
            invited={invited.has(item.person.id)}
            inviting={inviting}
            onInvite={() => onInvite(item.person)}
          />
        ))}
      </ul>
    </section>
  )
}

function ExcludedRow({
  item,
  invited,
  inviting,
  onInvite,
}: {
  item: Excluded
  invited: boolean
  inviting: boolean
  onInvite: () => void
}) {
  const { person, reason } = item
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="min-w-0 flex-1 basis-48">
        <span className="block text-ui font-medium wrap-break-word text-ink">
          {person.name}
        </span>
        <span className="block text-caption break-all text-ink-muted">
          {person.email}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
          {invited && <Check aria-hidden className="size-3 text-success-fg" />}
          {invited ? "Invite sent just now" : excludedNote(item)}
        </span>
      </span>
      {reason === "not-activated" ? (
        <button
          type="button"
          onClick={onInvite}
          disabled={inviting}
          aria-label={`${person.activation === "not-invited" && !invited ? "Send an invite to" : "Resend the invite to"} ${person.name}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Mail className="size-3.5" />
          {person.activation === "not-invited" && !invited
            ? "Send invite"
            : "Resend invite"}
        </button>
      ) : (
        <Link
          href="/company/people"
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Set an amount
        </Link>
      )}
    </li>
  )
}
