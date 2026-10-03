import type { PaymentStatus, Receipt, RunCreated } from "../schemas"

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
    me: { available: 8_000_000_000n, pending: 0n } as Ledger,
    payments,
    amounts: new Map<string, bigint>([
      [seedPeople[0].id, 4_200_000_000n],
      [seedPeople[1].id, 3_800_000_000n],
      [seedPeople[2].id, 6_300_000_000n],
      [seedPeople[3].id, 9_500_000_000n],
    ]),
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
    enrolled: new Set<string>(),
  }
}

export let db = seed()

export function resetDb() {
  db = seed()
}

export function nextId() {
  return ++db.counter
}
