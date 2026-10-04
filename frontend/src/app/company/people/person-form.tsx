"use client"

import { useId, useState } from "react"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { formatBaseUnits } from "@/lib/money"
import { shortName } from "@/lib/people/display"
import {
  AmountNotSavedError,
  DuplicateEmailError,
  peopleMessageFor,
} from "@/lib/people/errors"
import {
  dollarsToUnits,
  personFieldsSchema,
  personSchema,
} from "@/lib/people/schema"
import {
  kindLabels,
  personKinds,
  type PersonKind,
  type PersonRecord,
} from "@/lib/people/types"
import { useSavePerson } from "@/lib/queries/people"
import { cn } from "@/lib/utils"

type Errors = Partial<Record<"name" | "email" | "monthlyAmount", string>>

// What the proof service holds for the person being edited. Unknown while the
// amounts are loading or failed to load: the field is then optional and blank.
export type CurrentAmount =
  { known: true; units: string | undefined } | { known: false }

export function PersonFormModal({
  person,
  amount,
  open,
  onOpenChange,
}: {
  // Absent when adding.
  person?: PersonRecord
  amount: CurrentAmount
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const save = useSavePerson()

  // A save in flight keeps the dialog, so its outcome is never missed.
  function handleOpenChange(next: boolean) {
    if (!next && save.isPending) return
    if (!next) save.reset()
    onOpenChange(next)
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={person ? `Edit ${shortName(person.name)}` : "Add a person"}
      description={
        person
          ? "Update their details. The monthly amount is saved separately."
          : "You can invite them once they are on the list."
      }
    >
      {/* Remount per open so the fields start from the person being edited. */}
      {open && (
        <PersonForm
          person={person}
          amount={amount}
          save={save}
          onDone={() => handleOpenChange(false)}
        />
      )}
    </Modal>
  )
}

function PersonForm({
  person,
  amount: current,
  save,
  onDone,
}: {
  person?: PersonRecord
  amount: CurrentAmount
  save: ReturnType<typeof useSavePerson>
  onDone: () => void
}) {
  const id = useId()
  const [name, setName] = useState(person?.name ?? "")
  const [email, setEmail] = useState(person?.email ?? "")
  const [kind, setKind] = useState<PersonKind>(person?.kind ?? "employee")
  const [amount, setAmount] = useState(
    current.known && current.units !== undefined
      ? formatBaseUnits(BigInt(current.units))
      : "",
  )
  const [errors, setErrors] = useState<Errors>({})

  // A stale message would contradict what the field now holds.
  const clearError = (field: keyof Errors) =>
    setErrors((current) => ({ ...current, [field]: undefined }))

  // Blank is allowed only when editing a person whose amount can't be read:
  // it means "leave it as it is".
  const amountOptional = person !== undefined && !current.known
  const hasInvite =
    person?.activation === "invited" || person?.activation === "invite-expired"
  const emailChanged =
    person !== undefined &&
    email.trim().toLowerCase() !== person.email.toLowerCase()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const leaveAmount = amountOptional && amount.trim() === ""
    const fields = personFieldsSchema.safeParse({ name, email, kind })
    const monthly = leaveAmount
      ? undefined
      : personSchema.shape.monthlyAmount.safeParse(
          amount.trim() === "" ? undefined : Number(amount),
        )
    if (!fields.success || (monthly && !monthly.success)) {
      const next: Errors = {}
      if (!fields.success) {
        for (const issue of fields.error.issues) {
          const field = issue.path[0] as keyof Errors
          next[field] ??= issue.message
        }
      }
      if (monthly && !monthly.success) {
        next.monthlyAmount = monthly.error.issues[0].message
      }
      setErrors(next)
      return
    }
    setErrors({})
    const input = fields.data
    const units =
      monthly?.data === undefined ? undefined : dollarsToUnits(monthly.data)
    save.mutate(
      {
        id: person?.id,
        input,
        // An unchanged amount is not written again.
        amount: current.known && units === current.units ? undefined : units,
        invitedEmail: hasInvite ? person?.email : undefined,
      },
      {
        onSuccess: onDone,
        onError: (error) => {
          if (error instanceof DuplicateEmailError) {
            setErrors({ email: peopleMessageFor(error) })
          }
          // The person is on the list now, so adding again would duplicate them.
          if (error instanceof AmountNotSavedError && !person) onDone()
        },
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field id={`${id}-name`} label="Name" error={errors.name}>
        <input
          id={`${id}-name`}
          autoFocus
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            clearError("name")
          }}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? `${id}-name-error` : undefined}
          className={cn(fieldClass, "h-9")}
        />
      </Field>
      <Field id={`${id}-email`} label="Email" error={errors.email}>
        <input
          id={`${id}-email`}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            clearError("email")
          }}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? `${id}-email-error` : undefined}
          className={cn(fieldClass, "h-9")}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-kind`} label="Kind">
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value as PersonKind)}
            className={cn(fieldClass, "h-9")}
          >
            {personKinds.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id={`${id}-amount`}
          label="Monthly amount (USD)"
          error={errors.monthlyAmount}
          adornment={<WhoCanSee viewerRole="admin" hasAuditor={false} />}
        >
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
              clearError("monthlyAmount")
            }}
            aria-invalid={!!errors.monthlyAmount}
            aria-describedby={
              errors.monthlyAmount ? `${id}-amount-error` : `${id}-amount-hint`
            }
            className={cn(fieldClass, "h-9 font-mono tabular-nums")}
          />
        </Field>
      </div>
      <p
        id={`${id}-amount-hint`}
        className="text-caption/normal text-ink-muted"
      >
        {amountOptional ? "Leave this blank to keep the current amount. " : ""}
        Held encrypted by the payment service, never in the people list. Cadence
        can read it to prove payments.
      </p>
      {emailChanged && hasInvite && (
        <p className="text-caption/normal text-ink-muted">
          The invite already sent won&apos;t work for the new address. Send a
          new one after saving.
        </p>
      )}
      {save.isError && !(save.error instanceof DuplicateEmailError) && (
        <p role="alert" className="text-ui/normal text-danger-fg">
          {peopleMessageFor(save.error)}
        </p>
      )}
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
          disabled={save.isPending}
          className={buttonVariants()}
        >
          {save.isPending ? "Saving…" : person ? "Save changes" : "Add person"}
        </button>
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  error,
  adornment,
  children,
}: {
  id: string
  label: string
  error?: string
  adornment?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-ui font-medium text-ink">
          {label}
        </label>
        {adornment}
      </div>
      {children}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 text-caption text-danger-fg"
        >
          {error}
        </p>
      )}
    </div>
  )
}
