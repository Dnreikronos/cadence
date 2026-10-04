import { runRequestSchema, type RunRequest } from "@/lib/api/schemas"
import { formatUnits, sumUnits } from "@/lib/money"

// Who a payroll run can pay, and what it would cost. All amounts are base-unit strings.

export type PayrollActivation =
  "active" | "invited" | "invite-expired" | "not-invited"

export const payrollKinds = ["employee", "contractor", "supplier"] as const
export type PayrollKind = (typeof payrollKinds)[number]

export const kindLabels: Record<PayrollKind, string> = {
  employee: "Employee",
  contractor: "Contractor",
  supplier: "Supplier",
}

export type PayrollPerson = {
  id: string
  name: string
  email: string
  kind: PayrollKind
  activation: PayrollActivation
  // Held by the proof service. Null when none is set for this person.
  amount: string | null
}

// People rows plus the amounts the proof service holds, joined by person id.
export function withAmounts(
  people: readonly Omit<PayrollPerson, "amount">[],
  amounts: ReadonlyMap<string, string>,
): PayrollPerson[] {
  return people.map((person) => ({
    ...person,
    amount: amounts.get(person.id) ?? null,
  }))
}

export type ExcludedReason = "not-activated" | "no-amount"

export type Excluded = { person: PayrollPerson; reason: ExcludedReason }

// The service takes at most this many payments in one run (runRequestSchema).
export const maxRunPayments = 200

// Only an activated person with an amount can be paid: the service rejects anyone else
// with `recipient_not_activated`, so they are listed apart before a call is made.
export function splitRoster(people: readonly PayrollPerson[]) {
  const payable: PayrollPerson[] = []
  const excluded: Excluded[] = []
  for (const person of people) {
    if (person.activation !== "active") {
      excluded.push({ person, reason: "not-activated" })
    } else if (person.amount === null) {
      excluded.push({ person, reason: "no-amount" })
    } else {
      payable.push(person)
    }
  }
  return { payable, excluded }
}

const activationNotes: Record<PayrollActivation, string> = {
  "not-invited": "Hasn't been invited yet",
  invited: "Invite sent, not accepted yet",
  "invite-expired": "Invite expired",
  active: "",
}

export function excludedNote({ person, reason }: Excluded) {
  return reason === "no-amount"
    ? "No monthly amount set"
    : activationNotes[person.activation]
}

// Everyone is paid unless unticked, so a person who shows up later is included by default.
export function selectRecipients(
  payable: readonly PayrollPerson[],
  unticked: ReadonlySet<string>,
) {
  return payable.filter((person) => !unticked.has(person.id))
}

export function runTotal(recipients: readonly PayrollPerson[]) {
  return sumUnits(recipients.map((person) => person.amount ?? "0"))
}

// How much more private balance the run needs, or null when there is enough.
export function shortfall(total: string, available: string) {
  const missing = BigInt(total) - BigInt(available)
  return missing > 0n ? missing.toString() : null
}

export const peopleCount = (count: number) =>
  `${count} ${count === 1 ? "person" : "people"}`

export function payLabel(count: number, total: string) {
  return `Pay ${peopleCount(count)} · ${formatUnits(total)}`
}

export function buildRunRequest(
  companyWallet: string,
  recipients: readonly PayrollPerson[],
  idempotencyKey: string,
): RunRequest {
  return runRequestSchema.parse({
    company_wallet: companyWallet,
    payments: recipients.map((person) => ({
      person_id: person.id,
      amount: person.amount,
    })),
    idempotency_key: idempotencyKey,
  })
}

// One key per attempt. The same payment list keeps its key, so a double click or a
// retry after a lost response returns the run already created instead of a second
// one; a changed list is a different attempt and gets its own.
export type AttemptKey = { fingerprint: string; key: string }

export function fingerprintOf(
  companyWallet: string,
  recipients: readonly PayrollPerson[],
) {
  return JSON.stringify([
    companyWallet,
    recipients.map((person) => [person.id, person.amount]),
  ])
}

export function attemptKey(
  previous: AttemptKey | null,
  fingerprint: string,
  makeKey: () => string,
): AttemptKey {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, key: makeKey() }
}
