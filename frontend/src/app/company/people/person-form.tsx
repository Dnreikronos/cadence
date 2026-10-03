"use client"

import { useId, useState } from "react"
import { toast } from "sonner"
import { Modal } from "@/components/ui/modal"
import { buttonVariants } from "@/components/ui/button"
import { fieldClass } from "@/components/ui/field"
import { WhoCanSee } from "@/components/ui/who-can-see"
import { personSchema } from "@/lib/people/schema"
import { useSavePerson } from "@/lib/people/queries"
import {
  kindLabels,
  personKinds,
  type Person,
  type PersonKind,
} from "@/lib/people/types"
import { cn } from "@/lib/utils"

type Errors = Partial<Record<"name" | "email" | "monthlyAmount", string>>

export function PersonFormModal({
  person,
  open,
  onOpenChange,
}: {
  // Absent when adding.
  person?: Person
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={person ? `Edit ${person.name}` : "Add a person"}
      description={
        person
          ? "Changing the email cancels any invite sent to the old address."
          : "You can invite them once they are on the list."
      }
    >
      {/* Remount per open so the fields start from the person being edited. */}
      {open && (
        <PersonForm person={person} onDone={() => onOpenChange(false)} />
      )}
    </Modal>
  )
}

function PersonForm({
  person,
  onDone,
}: {
  person?: Person
  onDone: () => void
}) {
  const id = useId()
  const save = useSavePerson()
  const [name, setName] = useState(person?.name ?? "")
  const [email, setEmail] = useState(person?.email ?? "")
  const [kind, setKind] = useState<PersonKind>(person?.kind ?? "employee")
  const [amount, setAmount] = useState(
    person ? String(person.monthlyAmount) : "",
  )
  const [errors, setErrors] = useState<Errors>({})

  // A stale message would contradict what the field now holds.
  const clearError = (field: keyof Errors) =>
    setErrors((current) => ({ ...current, [field]: undefined }))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = personSchema.safeParse({
      name,
      email,
      kind,
      monthlyAmount: amount.trim() === "" ? undefined : Number(amount),
    })
    if (!parsed.success) {
      const next: Errors = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof Errors
        next[field] ??= issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    save.mutate(
      { id: person?.id, input: parsed.data },
      {
        onSuccess: () => {
          toast.success(person ? "Changes saved" : `${parsed.data.name} added`)
          onDone()
        },
        onError: (error) => toast.error(error.message),
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
        Stored encrypted. The amount is never saved in our database as readable
        text.
      </p>
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
