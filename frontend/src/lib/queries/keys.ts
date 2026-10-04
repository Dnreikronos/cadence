import type { PageQuery } from "@/lib/api/client"

const people = ["people"] as const
const balance = ["balance"] as const
const deposit = ["deposit"] as const
const payments = ["payments"] as const
const runs = ["runs"] as const
const auditors = ["auditors"] as const
const accessLog = ["access-log"] as const
const status = ["status"] as const
const receipts = ["receipts"] as const

// Every query key in the app, so a mutation can invalidate exactly what it changed:
// `queryKeys.payments.all` reaches every payments list, `.company(query)` one of them.
// Each group starts with an `all` prefix, and the keys under it extend it.
export const queryKeys = {
  // The people table (Supabase in production, a mock until then).
  people: {
    all: people,
    list: () => [...people, "list"] as const,
    detail: (id: string) => [...people, "detail", id] as const,
    // Per-person amounts live in the proof service.
    amounts: (query: PageQuery = {}) => [...people, "amounts", query] as const,
  },
  // Private balances: the company's and the signed-in recipient's.
  balance: {
    all: balance,
    company: () => [...balance, "company"] as const,
    me: () => [...balance, "me"] as const,
  },
  // The public USDC the company holds and can make private.
  deposit: {
    all: deposit,
    info: () => [...deposit, "info"] as const,
  },
  payments: {
    all: payments,
    company: (query: PageQuery = {}) =>
      [...payments, "company", query] as const,
    me: (query: PageQuery = {}) => [...payments, "me", query] as const,
    audit: (companyId: string, query: PageQuery = {}) =>
      [...payments, "audit", companyId, query] as const,
  },
  runs: {
    all: runs,
    detail: (id: string) => [...runs, "detail", id] as const,
  },
  auditors: {
    all: auditors,
    list: () => [...auditors, "list"] as const,
  },
  // Who read what, for the auditor panel and the company's own view of it.
  accessLog: {
    all: accessLog,
    list: (query: PageQuery = {}) => [...accessLog, "list", query] as const,
  },
  // What the signed-in recipient still has to do before they can be paid.
  status: {
    all: status,
    me: () => [...status, "me"] as const,
  },
  // Receipts are built from payments, but cached on their own.
  receipts: {
    all: receipts,
    list: (query: PageQuery = {}) => [...receipts, "list", query] as const,
    detail: (paymentId: string) => [...receipts, "detail", paymentId] as const,
  },
}
