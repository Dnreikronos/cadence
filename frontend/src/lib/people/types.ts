export const personKinds = ["employee", "contractor", "supplier"] as const
export type PersonKind = (typeof personKinds)[number]

export const kindLabels: Record<PersonKind, string> = {
  employee: "Employee",
  contractor: "Contractor",
  supplier: "Supplier",
}

// Derived from person.status plus the pending invite row, if any.
export type Activation = "active" | "invited" | "invite-expired" | "not-invited"

// What the people table holds. The monthly amount is not here: it lives with the
// proof service, encrypted (B2), and is joined in by person id.
export type PersonRecord = {
  id: string
  name: string
  email: string
  kind: PersonKind
  activation: Activation
}

export type PersonInput = Pick<PersonRecord, "name" | "email" | "kind">
