import {
  runRequestSchema,
  type PaymentItem,
  type Run,
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
  // The Token-2022 account a run pays. Null until the person has configured one.
  tokenAccount: string | null
}

// People rows plus the amounts and token accounts the proof service holds, joined by
// person id.
export function withAmounts(
  people: readonly Omit<PayrollPerson, "amount" | "tokenAccount">[],
  amounts: ReadonlyMap<string, string>,
  accounts: ReadonlyMap<string, string> = new Map(),
): PayrollPerson[] {
  return people.map((person) => ({
    ...person,
    amount: amounts.get(person.id) ?? null,
    tokenAccount: accounts.get(person.id) ?? null,
  }))
}

export type ExcludedReason = "not-activated" | "no-amount" | "no-account"

export type Excluded = { person: PayrollPerson; reason: ExcludedReason }

// The service takes at most this many payments in one run (runRequestSchema).
export const maxRunPayments = 100

// Only an activated person with an amount and a token account can be paid: the service
// could not prepare a payment for anyone else, so they are listed apart before a call
// is made.
export function splitRoster(people: readonly PayrollPerson[]) {
  const payable: PayrollPerson[] = []
  const excluded: Excluded[] = []
  for (const person of people) {
    if (person.activation !== "active") {
      excluded.push({ person, reason: "not-activated" })
    } else if (person.amount === null) {
      excluded.push({ person, reason: "no-amount" })
    } else if (person.tokenAccount === null) {
      excluded.push({ person, reason: "no-account" })
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
  if (reason === "no-amount") return "No monthly amount set"
  if (reason === "no-account") return "Hasn't set up private payments yet"
  return activationNotes[person.activation]
}

// Someone paid inside this window is not ticked by default: running the roster again
// right after a run would pay them twice. Nothing in the service answers "was this
// person paid today", so the company's own payments are the record.
export const recentWindowMs = 24 * 60 * 60 * 1000

// Whether a payment may have paid the person. Only a payment that is known not to have
// moved money is left out: `failed`, and a `pending` one with no signature (nothing was
// sent yet). Everything else counts, because skipping a payment that did land pays the
// person twice: `confirmed`, `finalized` and `signed` and every status this app does not
// know, which the service may have added to say that money moved.
export function mayHaveBeenPaid(
  payment: Pick<PaymentItem, "status"> & { signature?: string | null },
) {
  if (payment.status === "failed") return false
  if (payment.status === "pending") return !!payment.signature
  return true
}

// Ids of the people with a payment that may have paid them inside the window. The admin
// can still tick one of them again, after the warning.
export function recentlyPaidIds(
  payments: readonly (Pick<
    PaymentItem,
    "status" | "paid_at" | "counterparty"
  > & { signature?: string | null })[],
  now: number,
  windowMs = recentWindowMs,
) {
  const paid = new Set<string>()
  for (const payment of payments) {
    if (!mayHaveBeenPaid(payment)) continue
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
  sender: string,
  aesKey: string,
  recipients: readonly PayrollPerson[],
): RunRequest {
  return runRequestSchema.parse({
    company_wallet: companyWallet,
    sender,
    aes_key: aesKey,
    // A payment's position is its index here, which is how a run row is matched to
    // the person it pays.
    payments: recipients.map((person) => ({
      recipient: person.tokenAccount,
      amount: person.amount,
    })),
  })
}

// What `POST /runs` answered must be what was asked: the same wallet and sender, our
// wallet as the only signer, and each position paying the account asked for at that
// index, once. Anything else is not signed, since its payments are not the approved ones.
export function createdMatches(request: RunRequest, run: Run) {
  const positions = run.payments.map((payment) => payment.position)
  return (
    run.company_wallet === request.company_wallet &&
    run.sender === request.sender &&
    run.required_signers.length === 1 &&
    run.required_signers[0] === request.company_wallet &&
    run.payments.length === request.payments.length &&
    new Set(positions).size === positions.length &&
    run.payments.every(
      (payment) =>
        request.payments[payment.position]?.recipient === payment.destination,
    )
  )
}

// People who would be paid but have a payment of an earlier run that may have been sent
// and is not settled yet: they leave the roster until it is, since paying them again
// could pay them twice.
export function holdChecking(
  payable: readonly PayrollPerson[],
  checking: ReadonlySet<string>,
) {
  return {
    payable: payable.filter((person) => !checking.has(person.id)),
    checking: payable.filter((person) => checking.has(person.id)),
  }
}
