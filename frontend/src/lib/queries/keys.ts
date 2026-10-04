import type { PageQuery } from "@/lib/api/client"

// Who a cached answer belongs to. Balances are private, so their keys carry it.
export type ViewerScope = { email: string; company: string }

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
  // Private balances: the company's and the signed-in recipient's, per viewer, so
  // an answer cached for one person is never read by another on the same tab.
  balance: {
    all: balance,
    company: (viewer: ViewerScope) =>
      [...balance, "company", viewer.company, viewer.email] as const,
    me: (viewer: ViewerScope) =>
      [...balance, "me", viewer.company, viewer.email] as const,
    // The company balance as the deposit screen reads it, keyed by the wallet it
    // belongs to. Under `all`, so `invalidateBalances` refreshes it too.
    companyWallet: (wallet: string) =>
      [...balance, "company-wallet", wallet] as const,
  },
  // The public USDC the company holds and can make private.
  deposit: {
    all: deposit,
    publicUsdc: (wallet: string) =>
      [...deposit, "public-usdc", wallet] as const,
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
    me: (viewer: ViewerScope) =>
      [...status, "me", viewer.company, viewer.email] as const,
  },
  // Receipts are built from payments, but cached on their own.
  receipts: {
    all: receipts,
    list: (query: PageQuery = {}) => [...receipts, "list", query] as const,
    detail: (paymentId: string) => [...receipts, "detail", paymentId] as const,
  },
}
