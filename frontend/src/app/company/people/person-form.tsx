"use client"

import { useId, useState } from "react"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { DECIMAL_HINT, isCommaDecimal } from "@/lib/deposit/schema"
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
import type { CurrentAmount } from "@/lib/people/view"
import { useSavePerson } from "@/lib/queries/people"
import { cn } from "@/lib/utils"

type Errors = Partial<Record<"name" | "email" | "monthlyAmount", string>>

export function PersonFormModal({
  person,
  amount,
  hasAuditor,
  open,
  onOpenChange,
  finalFocus,
}: {
  // Absent when adding.
  person?: PersonRecord
  amount: CurrentAmount
  hasAuditor: boolean | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus?: () => HTMLElement | boolean
}) {
  const save = useSavePerson()
  const [blocked, setBlocked] = useState(false)

  // A save in flight keeps the dialog, so its outcome is never missed: a try to
  // close it says so instead of doing nothing.
  function handleOpenChange(next: boolean) {
    if (!next && save.isPending) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    if (!next) save.reset()
    onOpenChange(next)
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      finalFocus={finalFocus}
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
          hasAuditor={hasAuditor}
          save={save}
          blocked={blocked && save.isPending}
          onDone={() => handleOpenChange(false)}
        />
      )}
    </Modal>
  )
}

function PersonForm({
  person,
  amount: current,
  hasAuditor,
  save,
  blocked,
  onDone,
}: {
  person?: PersonRecord
  amount: CurrentAmount
  hasAuditor: boolean | undefined
  save: ReturnType<typeof useSavePerson>
  blocked: boolean
  onDone: () => void
}) {
  const id = useId()
  const [name, setName] = useState(person?.name ?? "")
  const [email, setEmail] = useState(person?.email ?? "")
  const [kind, setKind] = useState<PersonKind>(person?.kind ?? "employee")
  // The amount as the form opened with it. It may have sub-cent digits that the
  // two-decimal rule would refuse, so a field left as it was is not validated or
  // written again.
  const [initialAmount] = useState(
    current.known && current.units !== undefined
      ? formatBaseUnits(BigInt(current.units))
      : "",
  )
  const [amount, setAmount] = useState(initialAmount)
  const [errors, setErrors] = useState<Errors>({})

  // A stale message would contradict what the field now holds.
  const clearError = (field: keyof Errors) =>
    setErrors((current) => ({ ...current, [field]: undefined }))

  // Blank is allowed only when editing a person whose amount can't be read:
  // it means "leave it as it is".
  const amountOptional = person !== undefined && !current.known
  const untouched = initialAmount !== "" && amount === initialAmount
  const hasInvite =
    person?.activation === "invited" || person?.activation === "invite-expired"
  const emailChanged =
    person !== undefined &&
    email.trim().toLowerCase() !== person.email.toLowerCase()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const leaveAmount = untouched || (amountOptional && amount.trim() === "")
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
        next.monthlyAmount = isCommaDecimal(amount)
          ? DECIMAL_HINT
          : monthly.error.issues[0].message
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
        // An unchanged amount is not written again. An unknown one always is.
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
          adornment={<WhoCanSee viewerRole="admin" hasAuditor={hasAuditor} />}
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
      {emailChanged && person?.activation === "active" && (
        <p className="text-caption/normal text-ink-muted">
          Their sign-in is not changed: they keep signing in with the email they
          joined with.
        </p>
      )}
      {blocked && (
        <p role="status" className="text-ui/normal text-ink-muted">
          Still saving. This closes when it&apos;s done.
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
          disabled={save.isPending}
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
