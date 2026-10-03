export const personKinds = ["employee", "contractor", "supplier"] as const
export type PersonKind = (typeof personKinds)[number]

export const kindLabels: Record<PersonKind, string> = {
  employee: "Employee",
  contractor: "Contractor",
  supplier: "Supplier",
}

// Derived from person.status plus the pending invite row, if any.
export type Activation = "active" | "invited" | "invite-expired" | "not-invited"

export type Person = {
  id: string
  name: string
  email: string
  kind: PersonKind
  activation: Activation
  // Lives with the proof service, encrypted (B2). Never a Supabase column.
  monthlyAmount: number
}

export type PersonInput = Pick<
  Person,
  "name" | "email" | "kind" | "monthlyAmount"
>
