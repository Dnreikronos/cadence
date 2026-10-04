import {
  knownPaymentStatus,
  runRequestSchema,
  type PaymentItem,
  type RunCreated,
  type RunRequest,
} from "@/lib/api/schemas"
import { formatBaseUnits, formatUnits, sumUnits } from "@/lib/money"

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

// The service takes at most this many payments in one run (runRequestSchema): its body
// limit is 8 KiB and an entry is about 80 bytes of JSON.
export const maxRunPayments = 100

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

// Someone paid inside this window is not ticked by default: running the roster again
// right after a run would pay them twice. Nothing in the service answers "was this
// person paid today", so the company's own payments are the record.
export const recentWindowMs = 24 * 60 * 60 * 1000

// Ids of the people with a confirmed payment inside the window.
export function recentlyPaidIds(
  payments: readonly Pick<PaymentItem, "status" | "paid_at" | "counterparty">[],
  now: number,
  windowMs = recentWindowMs,
) {
  const paid = new Set<string>()
  for (const payment of payments) {
    // An unknown status is pending, so it never counts as paid.
    if (knownPaymentStatus(payment.status) !== "confirmed") continue
    const at = Date.parse(payment.paid_at)
    if (Number.isFinite(at) && at >= now - windowMs) {
      paid.add(payment.counterparty.id)
    }
  }
  return paid
}

// What the admin chose by hand: true ticks, false unticks. Without a choice a person is
// ticked unless they were paid recently.
export type Choices = Readonly<Record<string, boolean>>

export const isTicked = (
  id: string,
  recentlyPaid: ReadonlySet<string>,
  choices: Choices,
) => choices[id] ?? !recentlyPaid.has(id)

export function selectRecipients(
  payable: readonly PayrollPerson[],
  recentlyPaid: ReadonlySet<string>,
  choices: Choices,
) {
  return payable.filter((person) => isTicked(person.id, recentlyPaid, choices))
}

// Ticked despite a payment in the last 24 hours.
export const repaid = (
  recipients: readonly PayrollPerson[],
  recentlyPaid: ReadonlySet<string>,
) => recipients.filter((person) => recentlyPaid.has(person.id))

// "Select everyone" ticks whoever was not paid recently; clearing unticks all.
export function allChoices(
  payable: readonly PayrollPerson[],
  recentlyPaid: ReadonlySet<string>,
  selectAll: boolean,
): Choices {
  return Object.fromEntries(
    payable.map((person) => [
      person.id,
      selectAll && !recentlyPaid.has(person.id),
    ]),
  )
}

export function runTotal(recipients: readonly PayrollPerson[]) {
  return sumUnits(recipients.map((person) => person.amount ?? "0"))
}

// How much more private balance the run needs, or null when there is enough.
export function shortfall(total: string, available: string) {
  const missing = BigInt(total) - BigInt(available)
  return missing > 0n ? missing.toString() : null
}

// An amount in dollars, exact: whole cents as usual, anything finer in full, since a
// deposit rounded down to the cent would still leave the run short.
export function formatExact(units: string) {
  const value = BigInt(units)
  return value % 10_000n === 0n
    ? formatUnits(units)
    : `${formatBaseUnits(value)} USDC`
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

// What `POST /runs` answered must be what was asked: the same people, once each. Anything
// else is not signed, since the payments it prepared are not the ones that were approved.
export function createdMatches(request: RunRequest, created: RunCreated) {
  const asked = request.payments.map((payment) => payment.person_id).sort()
  const got = created.payments.map((payment) => payment.person_id).sort()
  const paymentIds = new Set(created.payments.map((p) => p.payment_id))
  return (
    asked.length === got.length &&
    asked.every((id, index) => id === got[index]) &&
    new Set(got).size === got.length &&
    paymentIds.size === created.payments.length
  )
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
