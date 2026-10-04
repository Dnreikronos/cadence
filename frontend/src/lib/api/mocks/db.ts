import type {
  AccessLogItem,
  AuditorStatus,
  PaymentStatus,
  Receipt,
  RunCreated,
} from "../schemas"

// Fixed ids so tests and screens can refer to the seed data.
export const COMPANY_ID = "c0000000-0000-4000-8000-000000000001"
export const COMPANY_WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
export const ME_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"

export type MockPerson = { id: string; name: string; activated: boolean }

export type MockPayment = {
  id: string
  runId: string | null
  personId: string
  amount: bigint
  status: "pending" | "confirmed" | "failed"
  paidAt: string
  signature: string | null
}

export type MockRequest = {
  kind: string
  wallet: string
  amount?: bigint
  // How many confirm calls have asked so far.
  polls: number
  receipt?: Receipt
}

export type MockRunPayment = {
  paymentId: string
  personId: string
  amount: bigint
  status: PaymentStatus
  failure: string | null
  signature: string | null
  request: string
  polls: number
  // Transactions issued for this payment: the first, then one per retry.
  attempts: number
  receipt?: Receipt
}

export type MockAuditor = {
  id: string
  email: string
  // Accepted: an auditor. Otherwise a pending invite, which lapses after a week.
  accepted: boolean
  invitedAt: string
}

export const INVITE_TTL_MS = 7 * 86_400_000

export function auditorStatus(
  auditor: MockAuditor,
  now = Date.now(),
): AuditorStatus {
  if (auditor.accepted) return "active"
  return now - Date.parse(auditor.invitedAt) > INVITE_TTL_MS
    ? "invite-expired"
    : "invited"
}

export const seedPeople: MockPerson[] = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Bruno Costa",
    activated: true,
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Mariana Souza",
    activated: false,
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    name: "Diego Martins",
    activated: true,
  },
  {
    id: "a0000000-0000-4000-8000-000000000004",
    name: "Northwind Audit",
    activated: true,
  },
]
// The signed-in recipient in the mock is Bruno.
export const ME_PERSON = seedPeople[0].id

type Ledger = { available: bigint; pending: bigint }

// Dated from now, so the invite stays pending and the other stays lapsed
// however long the mock has been around.
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString()

function seedAuditors(): MockAuditor[] {
  return [
    {
      id: "d0000000-0000-4000-8000-000000000001",
      email: "ana.ribeiro@northwind-audit.example",
      accepted: true,
      invitedAt: daysAgo(24),
    },
    {
      id: "d0000000-0000-4000-8000-000000000002",
      email: "paulo.lima@northwind-audit.example",
      accepted: false,
      invitedAt: daysAgo(2),
    },
    {
      id: "d0000000-0000-4000-8000-000000000003",
      email: "rita.alves@northwind-audit.example",
      accepted: false,
      invitedAt: daysAgo(14),
    },
  ]
}

// Twenty-five reads, one an hour, newest first. Who and what, never an amount.
const accessReads: Pick<AccessLogItem, "actor" | "action" | "scope">[] = [
  {
    actor: { kind: "service", label: "Payroll run" },
    action: "read_balance",
    scope: "Company balance",
  },
  {
    actor: { kind: "company", label: "Solaris admin" },
    action: "read_payments",
    scope: "Company payments",
  },
  {
    actor: { kind: "recipient", label: "Bruno Costa" },
    action: "read_balance",
    scope: "Own balance",
  },
  {
    actor: { kind: "auditor", label: "Ana Ribeiro" },
    action: "read_payments",
    scope: "Company payments",
  },
  {
    actor: { kind: "recipient", label: "Bruno Costa" },
    action: "export_csv",
    scope: "Own payments",
  },
]

function seedAccessLog(): AccessLogItem[] {
  const newest = Date.parse("2026-10-03T18:00:00Z")
  return Array.from({ length: 25 }, (_, i) => ({
    id: `e0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    at: new Date(newest - i * 3_600_000).toISOString(),
    ...accessReads[i % accessReads.length],
  }))
}

function seed() {
  const payments: MockPayment[] = [
    [
      "b0000000-0000-4000-8000-000000000001",
      seedPeople[0].id,
      4_200_000_000n,
      "2026-09-01T12:00:00Z",
    ],
    [
      "b0000000-0000-4000-8000-000000000002",
      seedPeople[0].id,
      3_800_000_000n,
      "2026-08-01T12:00:00Z",
    ],
    [
      "b0000000-0000-4000-8000-000000000003",
      seedPeople[2].id,
      6_300_000_000n,
      "2026-09-01T12:00:00Z",
    ],
    [
      "b0000000-0000-4000-8000-000000000004",
      seedPeople[3].id,
      9_500_000_000n,
      "2026-09-01T12:00:00Z",
    ],
  ].map(([id, personId, amount, paidAt]) => ({
    id: id as string,
    runId: null,
    personId: personId as string,
    amount: amount as bigint,
    status: "confirmed" as const,
    paidAt: paidAt as string,
    signature: `seedSignature${(id as string).slice(-1)}`.padEnd(64, "x"),
  }))
  return {
    counter: 0,
    role: null as "admin" | "recipient" | "auditor" | null,
    company: { available: 84_000_000_000n, pending: 0n } as Ledger,
    // Plain USDC in the company wallet, read from the chain rather than the service.
    // A confirmed wrap spends it.
    publicUsdc: 12_500_000_000n,
    me: { available: 8_000_000_000n, pending: 0n } as Ledger,
    payments,
    amounts: new Map<string, bigint>([
      [seedPeople[0].id, 4_200_000_000n],
      [seedPeople[1].id, 3_800_000_000n],
      [seedPeople[2].id, 6_300_000_000n],
      [seedPeople[3].id, 9_500_000_000n],
    ]),
    // Who the service accepts as a person of the company. The real one asks the
    // people table, which a screen's own mock fills through `registerPerson`.
    people: new Set<string>(seedPeople.map((person) => person.id)),
    requests: new Map<string, MockRequest>(),
    runs: new Map<
      string,
      {
        id: string
        createdAt: string
        payments: MockRunPayment[]
        response?: RunCreated
      }
    >(),
    runKeys: new Map<string, string>(),
    // The demo recipient starts activated, so a page reload does not send every
    // recipient screen back to /activate; `resetAccountStatus` makes a new one.
    enrolled: new Set<string>([ME_WALLET]),
    // The account steps GET /me/status reports besides `enrolled`. The
    // recipient's wallet is linked by its enrollment or by its configure
    // confirm, whichever comes first, and the account configured by the latter.
    walletLinked: true,
    accountConfigured: true,
    auditors: seedAuditors(),
    accessLog: seedAccessLog(),
  }
}

export let db = seed()

export function resetDb() {
  db = seed()
}

// Back to a recipient who has done none of the activation steps, for a screen
// that wants to replay the flow. Balances, credits and requests already in
// flight are left alone: a configure confirmed afterwards still counts.
export function resetAccountStatus() {
  db.enrolled.clear()
  db.walletLinked = false
  db.accountConfigured = false
}

export function registerPerson(id: string) {
  db.people.add(id)
}

export function nextId() {
  return ++db.counter
}
