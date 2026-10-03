import { http, HttpResponse, delay } from "msw"
import type { z } from "zod"
import { formatBaseUnits } from "@/lib/deposit/schema"
import { base64FromBytes } from "../base64"
import * as s from "../schemas"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_PERSON,
  db,
  nextId,
  seedPeople,
  type MockPayment,
  type MockRunPayment,
} from "./db"
import { scenarios } from "./scenario"

// Mock of the proof service, written against docs/dev/API_CONTRACT.md. It answers
// in the contract's shapes and errors with only `{ "error": code }`.

const fail = (status: number, code: string, headers?: Record<string, string>) =>
  HttpResponse.json({ error: code }, { status, headers })

type Role = "admin" | "recipient" | "auditor"

// Common checks, in the order the real service makes them. Returns a response
// when the call should stop.
async function guard(request: Request, role?: Role) {
  if (scenarios.has("slow")) await delay(1500)
  if (scenarios.has("service-down")) return fail(503, "auth_unavailable")
  if (scenarios.has("rate-limited")) {
    return fail(429, "transfer_rate_limited", { "retry-after": "60" })
  }
  const header = request.headers.get("authorization") ?? ""
  if (scenarios.has("unauthenticated") || !/^Bearer .+/.test(header)) {
    return fail(401, "authentication_required")
  }
  // The mock only enforces a role once one is chosen with `setRole`.
  if (role && db.role && db.role !== role) return fail(403, "forbidden_role")
  return null
}

async function parse<T extends z.ZodType>(request: Request, schema: T) {
  const json = await request.json().catch(() => undefined)
  const parsed = schema.safeParse(json)
  if (parsed.success) return { data: parsed.data as z.output<T> }
  const amountIssue = parsed.error.issues.some((i) => i.path[0] === "amount")
  return {
    error: fail(400, amountIssue ? "invalid_amount" : "invalid_request"),
  }
}

const hex = (n: number) => n.toString(16).padStart(64, "0")

function prepared(wallet: string, version: 0 | 1 = 1) {
  const n = nextId()
  const transaction = base64FromBytes(
    Uint8Array.from({ length: 96 }, (_, i) => (n * 7 + i) % 256),
  )
  return {
    request_id: hex(n),
    transaction,
    transaction_version: version,
    required_signers: [wallet],
    recent_blockhash: `MockBlockhash${n}1111111111111111111111111111`,
    last_valid_block_height: 1000 + n,
  }
}

function remember(
  kind: string,
  p: ReturnType<typeof prepared>,
  wallet: string,
  amount?: bigint,
) {
  db.requests.set(p.request_id, { kind, wallet, amount, polls: 0 })
}

const notFoundCode: Record<string, string> = {
  wrap: "wrap_not_found",
  transfer: "transfer_not_found",
}

// Whether this confirm should still answer "not finalized": twice by default,
// like a real transaction that takes a moment.
const stillPending = (polls: number) => !scenarios.has("instant") && polls <= 2

function receiptFor(requestId: string, signature: string) {
  return {
    request_id: requestId,
    signature,
    slot: 507_000_000 + nextId(),
    status: "finalized" as const,
  }
}

async function confirmHandler(request: Request, kind: string) {
  const stopped = await guard(request)
  if (stopped) return stopped
  const { data, error } = await parse(request, s.confirmRequestSchema)
  if (error) return error
  const record = db.requests.get(data.request_id)
  if (!record || record.kind !== kind) {
    return fail(404, notFoundCode[kind] ?? "request_not_found")
  }
  // A repeat returns the stored receipt.
  if (record.receipt) return HttpResponse.json(record.receipt)
  if (scenarios.has("tx-failed")) return fail(409, "transaction_failed")
  record.polls += 1
  if (stillPending(record.polls)) return fail(409, "transaction_not_finalized")
  if (kind === "accounts/apply-pending" && scenarios.has("credit-mismatch")) {
    return fail(409, "credit_counter_mismatch")
  }
  record.receipt = receiptFor(data.request_id, data.signature)
  applyEffect(kind, record.wallet, record.amount)
  return HttpResponse.json(record.receipt)
}

function applyEffect(kind: string, wallet: string, amount?: bigint) {
  if (kind === "wrap" && amount) {
    db.company.pending += amount
  } else if (kind === "accounts/apply-pending") {
    const ledger = wallet === COMPANY_WALLET ? db.company : db.me
    ledger.available += ledger.pending
    ledger.pending = 0n
  } else if (kind === "unwrap" && amount) {
    db.me.available -= amount
  }
}

// ---- Reads ------------------------------------------------------------------

const personName = (id: string) =>
  seedPeople.find((p) => p.id === id)?.name ?? "Unknown"

function paymentItem(
  payment: MockPayment,
  counterparty: { id: string; name: string },
) {
  return {
    payment_id: payment.id,
    run_id: payment.runId,
    counterparty,
    amount: payment.amount.toString(),
    status: payment.status,
    transparent: false,
    paid_at: payment.paidAt,
    signature: payment.signature,
  }
}

function paged<T>(request: Request, rows: T[]) {
  const url = new URL(request.url)
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || 50, 1),
    100,
  )
  const start = Number(url.searchParams.get("cursor")) || 0
  const items = rows.slice(start, start + limit)
  const next = start + limit < rows.length ? String(start + limit) : null
  return HttpResponse.json({ items, next_cursor: next })
}

const newestFirst = (a: MockPayment, b: MockPayment) =>
  b.paidAt.localeCompare(a.paidAt)

function csv(rows: MockPayment[], name: (p: MockPayment) => string) {
  const lines = rows.map((p) =>
    [
      p.paidAt.slice(0, 10),
      name(p),
      formatBaseUnits(p.amount),
      p.status,
      p.signature ?? "",
    ].join(","),
  )
  return new HttpResponse(
    ["date,counterparty,amount,status,signature", ...lines].join("\n"),
    {
      headers: { "content-type": "text/csv; charset=utf-8" },
    },
  )
}

// ---- Reveal risk ------------------------------------------------------------

// Exact when the amount equals one the person received, near within 1%.
function revealRisk(amount: bigint) {
  const received = db.payments.filter(
    (p) => p.personId === ME_PERSON && p.status === "confirmed",
  )
  const exact = received.filter((p) => p.amount === amount)
  if (exact.length) return { level: "exact" as const, hits: exact }
  const near = received.filter((p) => {
    const diff = p.amount > amount ? p.amount - amount : amount - p.amount
    return diff * 100n <= p.amount
  })
  if (near.length) return { level: "near" as const, hits: near }
  return { level: "none" as const, hits: [] }
}

// ---- Runs -------------------------------------------------------------------

function runPaymentPrepared(runPayment: MockRunPayment) {
  const p = prepared(COMPANY_WALLET)
  remember("run-payment", p, COMPANY_WALLET, runPayment.amount)
  runPayment.request = p.request_id
  runPayment.polls = 0
  runPayment.status = "pending"
  runPayment.failure = null
  return {
    ...p,
    payment_id: runPayment.paymentId,
    person_id: runPayment.personId,
  }
}

function findRunPayment(runId: string, paymentId: string) {
  const run = db.runs.get(runId)
  const index = run?.payments.findIndex((p) => p.paymentId === paymentId) ?? -1
  return { run, index, payment: run?.payments[index] }
}

export const handlers = [
  http.get("*/health", async () => {
    if (scenarios.has("service-down")) {
      return HttpResponse.json(
        { status: "unavailable", build_sha: "mock", rpc_reachable: false },
        { status: 503 },
      )
    }
    return HttpResponse.json({
      status: "ok",
      build_sha: "mock",
      rpc_reachable: true,
    })
  }),

  // ---- Wrap
  http.post("*/wrap", async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.wrapRequestSchema)
    if (error) return error
    if (scenarios.has("setup-required") && !data.setup) {
      return fail(409, "confidential_setup_required")
    }
    const p = prepared(data.company_wallet, 0)
    remember("wrap", p, data.company_wallet, BigInt(data.amount))
    return HttpResponse.json({
      ...p,
      destination: "6xHqMockToken2022Account1111111111111111111",
      mint: "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb",
      deposit_state: "pending_after_confirmation",
    })
  }),
  http.post("*/wrap/confirm", ({ request }) => confirmHandler(request, "wrap")),

  // ---- Transfer
  http.post("*/transfer", async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.transferRequestSchema)
    if (error) return error
    const p = prepared(data.company_wallet, 1)
    remember("transfer", p, data.company_wallet, BigInt(data.amount))
    return HttpResponse.json({
      ...p,
      sender: data.sender,
      destination: data.recipient,
      mint: "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb",
    })
  }),
  http.post("*/transfer/confirm", ({ request }) =>
    confirmHandler(request, "transfer"),
  ),

  // ---- Runs
  http.post("*/runs", async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.runRequestSchema)
    if (error) return error

    // The same key returns the same run, with the transactions it first issued.
    const existing = db.runKeys.get(data.idempotency_key)
    if (existing) return HttpResponse.json(db.runs.get(existing)?.response)

    for (const payment of data.payments) {
      const person = seedPeople.find((p) => p.id === payment.person_id)
      if (!person) return fail(404, "person_not_found")
      if (!person.activated) return fail(409, "recipient_not_activated")
    }
    const runId = crypto.randomUUID()
    const run: NonNullable<ReturnType<typeof db.runs.get>> = {
      id: runId,
      createdAt: new Date().toISOString(),
      payments: data.payments.map<MockRunPayment>((p) => ({
        paymentId: crypto.randomUUID(),
        personId: p.person_id,
        amount: BigInt(p.amount),
        status: "pending",
        failure: null,
        signature: null,
        request: "",
        polls: 0,
      })),
    }
    db.runs.set(runId, run)
    db.runKeys.set(data.idempotency_key, runId)
    run.response = {
      run_id: run.id,
      payments: run.payments.map(runPaymentPrepared),
    }
    return HttpResponse.json(run.response)
  }),

  http.get("*/runs/:runId", async ({ request, params }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const run = db.runs.get(String(params.runId))
    if (!run) return fail(404, "run_not_found")
    return HttpResponse.json({
      run_id: run.id,
      created_at: run.createdAt,
      payments: run.payments.map((p, index) => ({
        payment_id: p.paymentId,
        person_id: p.personId,
        // A payment that never confirmed outlives its blockhash.
        status:
          scenarios.has("partial-failure") &&
          index === 2 &&
          p.status === "pending"
            ? "expired"
            : p.status,
        transparent: false,
        failure: p.failure,
        signature: p.signature,
      })),
    })
  }),

  http.post(
    "*/runs/:runId/payments/:paymentId/confirm",
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const { data, error } = await parse(request, s.paymentConfirmSchema)
      if (error) return error
      const { run, index, payment } = findRunPayment(
        String(params.runId),
        String(params.paymentId),
      )
      if (!run || !payment) return fail(404, "payment_not_found")
      if (payment.status === "confirmed") {
        return HttpResponse.json(
          receiptFor(payment.request, payment.signature ?? data.signature),
        )
      }
      const failing =
        scenarios.has("tx-failed") ||
        (scenarios.has("partial-failure") && (index === 1 || index === 2))
      if (failing) {
        if (index !== 2) {
          payment.status = "failed"
          payment.failure = "transaction_failed"
        }
        return fail(409, "transaction_failed")
      }
      payment.polls += 1
      payment.status = "signed"
      if (stillPending(payment.polls))
        return fail(409, "transaction_not_finalized")
      payment.status = "confirmed"
      payment.signature = data.signature
      db.me.pending += payment.personId === ME_PERSON ? payment.amount : 0n
      db.payments.push({
        id: payment.paymentId,
        runId: run.id,
        personId: payment.personId,
        amount: payment.amount,
        status: "confirmed",
        paidAt: new Date().toISOString(),
        signature: data.signature,
      })
      return HttpResponse.json(receiptFor(payment.request, data.signature))
    },
  ),

  http.post(
    "*/runs/:runId/payments/:paymentId/retry",
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const { payment } = findRunPayment(
        String(params.runId),
        String(params.paymentId),
      )
      if (!payment) return fail(404, "payment_not_found")
      return HttpResponse.json(runPaymentPrepared(payment))
    },
  ),

  // ---- Unwrap
  http.post("*/unwrap", async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.unwrapRequestSchema)
    if (error) return error
    const amount = BigInt(data.amount)
    if (amount > db.me.available) return fail(409, "invalid_confidential_state")
    const risk = revealRisk(amount)
    if (risk.level !== "none" && !data.acknowledge_reveal_risk) {
      return fail(409, "reveal_risk_not_acknowledged")
    }
    const p = prepared(data.wallet, 1)
    remember("unwrap", p, data.wallet, amount)
    return HttpResponse.json({
      ...p,
      reveal_risk: {
        level: risk.level,
        matches: risk.hits.map((hit) => ({
          payment_id: hit.id,
          paid_at: hit.paidAt,
        })),
      },
    })
  }),
  http.post("*/unwrap/confirm", ({ request }) =>
    confirmHandler(request, "unwrap"),
  ),

  // ---- Accounts and keys
  http.post("*/accounts/configure", async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.walletRequestSchema)
    if (error) return error
    const p = prepared(data.wallet, 1)
    remember("accounts/configure", p, data.wallet)
    return HttpResponse.json(p)
  }),
  http.post("*/accounts/configure/confirm", ({ request }) =>
    confirmHandler(request, "accounts/configure"),
  ),
  http.post("*/accounts/apply-pending", async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.walletRequestSchema)
    if (error) return error
    const p = prepared(data.wallet, 1)
    remember("accounts/apply-pending", p, data.wallet)
    return HttpResponse.json(p)
  }),
  http.post("*/accounts/apply-pending/confirm", ({ request }) =>
    confirmHandler(request, "accounts/apply-pending"),
  ),
  http.post("*/keys/enroll", async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.enrollRequestSchema)
    if (error) return error
    if (db.enrolled.has(data.wallet)) return fail(409, "key_already_enrolled")
    db.enrolled.add(data.wallet)
    return HttpResponse.json({ status: "enrolled" })
  }),

  // ---- Reads
  http.get("*/me/balance", async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    return HttpResponse.json({
      available: db.me.available.toString(),
      pending: db.me.pending.toString(),
      as_of_slot: 507_000_000 + db.counter,
    })
  }),
  http.get("*/me/payments", async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    const rows = db.payments
      .filter((p) => p.personId === ME_PERSON)
      .sort(newestFirst)
      .map((p) => paymentItem(p, { id: COMPANY_ID, name: "Solaris" }))
    return paged(request, rows)
  }),
  http.get("*/company/payments", async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const rows = [...db.payments]
      .sort(newestFirst)
      .map((p) =>
        paymentItem(p, { id: p.personId, name: personName(p.personId) }),
      )
    return paged(request, rows)
  }),
  http.get("*/company/people/amounts", async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const rows = [...db.amounts].map(([person_id, amount]) => ({
      person_id,
      amount: amount.toString(),
    }))
    return paged(request, rows)
  }),
  http.put("*/company/people/:personId/amount", async ({ request, params }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.setAmountRequestSchema)
    if (error) return error
    const id = String(params.personId)
    if (!seedPeople.some((p) => p.id === id))
      return fail(404, "person_not_found")
    db.amounts.set(id, BigInt(data.amount))
    return HttpResponse.json({ person_id: id, amount: data.amount })
  }),
  http.post(
    "*/company/people/:personId/invite",
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      if (!seedPeople.some((p) => p.id === String(params.personId))) {
        return fail(404, "person_not_found")
      }
      return HttpResponse.json({
        status: "sent",
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
    },
  ),
  http.get("*/audit/:companyId/payments", async ({ request, params }) => {
    const stopped = await guard(request, "auditor")
    if (stopped) return stopped
    // A grant on one company is useless against another, and never confirms it exists.
    if (params.companyId !== COMPANY_ID) return fail(404, "not_found")
    const rows = [...db.payments]
      .sort(newestFirst)
      .map((p) =>
        paymentItem(p, { id: p.personId, name: personName(p.personId) }),
      )
    return paged(request, rows)
  }),

  // ---- CSV
  http.get("*/company/export.csv", async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    return csv(db.payments, (p) => personName(p.personId))
  }),
  http.get("*/me/export.csv", async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    return csv(
      db.payments.filter((p) => p.personId === ME_PERSON),
      () => "Solaris",
    )
  }),
  http.get("*/audit/:companyId/export.csv", async ({ request, params }) => {
    const stopped = await guard(request, "auditor")
    if (stopped) return stopped
    if (params.companyId !== COMPANY_ID) return fail(404, "not_found")
    return csv(db.payments, (p) => personName(p.personId))
  }),
]
