import { http, HttpResponse, delay } from "msw"
import { z } from "zod"
import { formatBaseUnits } from "@/lib/deposit/schema"
import { base64FromBytes } from "../base64"
import { MOCK_ORIGIN } from "../config"
import * as s from "../schemas"
import { randomUuid } from "../uuid"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_PERSON,
  ME_WALLET,
  auditorStatus,
  db,
  nextId,
  seedPeople,
  type MockAuditor,
  type MockPayment,
  type MockRunPayment,
} from "./db"
import { scenarios, timing } from "./scenario"

// Mock of the proof service, written against docs/dev/API_CONTRACT.md. It answers
// in the contract's shapes and errors with only `{ "error": code }`.

const fail = (status: number, code: string, headers?: Record<string, string>) =>
  HttpResponse.json({ error: code }, { status, headers })

// Patterns carry the origin, so a Next route on the app's own origin that shares
// a path (say /me/payments) is never answered by the mock.
const at = (path: string) => `${MOCK_ORIGIN}${path}`

type Role = "admin" | "recipient" | "auditor"

// Common checks, in the order the real service makes them. Returns a response
// when the call should stop.
async function guard(
  request: Request,
  role?: Role,
  rateLimitCode = "transfer_rate_limited",
) {
  if (scenarios.has("slow")) await delay(timing.slowMs)
  if (scenarios.has("service-down")) return fail(503, "auth_unavailable")
  if (scenarios.has("rate-limited")) {
    return fail(429, rateLimitCode, { "retry-after": "60" })
  }
  const header = request.headers.get("authorization") ?? ""
  if (scenarios.has("unauthenticated") || !/^Bearer .+/.test(header)) {
    return fail(401, "authentication_required")
  }
  // The mock only enforces a role once one is chosen with `setRole`.
  if (role && db.role && db.role !== role) return fail(403, "forbidden_role")
  return null
}

// Never a 500: whatever goes wrong in validation is a bad request.
async function parse<T extends z.ZodType>(request: Request, schema: T) {
  const json = await request.json().catch(() => undefined)
  try {
    const parsed = schema.safeParse(json)
    if (parsed.success) return { data: parsed.data as z.output<T> }
    const amountIssue = parsed.error.issues.some((i) =>
      i.path.includes("amount"),
    )
    return {
      error: fail(400, amountIssue ? "invalid_amount" : "invalid_request"),
    }
  } catch {
    return { error: fail(400, "invalid_request") }
  }
}

// Confirm bodies are only checked for shape here. The id and the signature get
// their own codes below, as the real service answers them.
const confirmBody = z.strictObject({
  request_id: z.string(),
  signature: z.string(),
})
const signatureBody = z.strictObject({ signature: z.string() })

function badConfirm(requestId: string | undefined, signature: string) {
  if (
    requestId !== undefined &&
    !s.requestIdSchema.safeParse(requestId).success
  ) {
    return fail(400, "invalid_request_id")
  }
  if (!s.signatureSchema.safeParse(signature).success) {
    return fail(400, "invalid_signature")
  }
  return null
}

const alreadyConfirmedCode: Record<string, string> = {
  wrap: "wrap_already_confirmed",
  transfer: "transfer_already_confirmed",
  "run-payment": "transfer_already_confirmed",
}

// A repeat with the same signature returns the stored receipt; another
// signature for a confirmed request is a conflict.
function replay(kind: string, receipt: s.Receipt, signature: string) {
  if (receipt.signature !== signature) {
    return fail(409, alreadyConfirmedCode[kind] ?? "already_confirmed")
  }
  return HttpResponse.json(receipt)
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
  const stopped = await guard(
    request,
    undefined,
    kind === "wrap" ? "wrap_rate_limited" : "transfer_rate_limited",
  )
  if (stopped) return stopped
  const { data, error } = await parse(request, confirmBody)
  if (error) return error
  const bad = badConfirm(data.request_id, data.signature)
  if (bad) return bad
  const record = db.requests.get(data.request_id)
  if (!record || record.kind !== kind) {
    return fail(404, notFoundCode[kind] ?? "request_not_found")
  }
  if (record.receipt) return replay(kind, record.receipt, data.signature)
  if (scenarios.has("tx-failed")) return fail(409, "transaction_failed")
  record.polls += 1
  if (stillPending(record.polls)) return fail(409, "transaction_not_finalized")
  if (kind === "accounts/apply-pending" && scenarios.has("credit-mismatch")) {
    return fail(409, "credit_counter_mismatch")
  }
  const rejected = applyEffect(kind, record.wallet, record.amount)
  if (rejected) return rejected
  record.receipt = receiptFor(data.request_id, data.signature)
  return HttpResponse.json(record.receipt)
}

// What a finalized transaction does to the ledgers. A ledger never goes
// negative: a confirm that would is refused, and changes nothing.
function applyEffect(kind: string, wallet: string, amount?: bigint) {
  if (kind === "wrap" && amount) {
    db.company.pending += amount
  } else if (kind === "accounts/configure" && wallet !== COMPANY_WALLET) {
    // Configuring needs a linked wallet, so it links one too. The company's
    // wallet is not the recipient whose status is reported.
    db.walletLinked = true
    db.accountConfigured = true
  } else if (kind === "accounts/apply-pending") {
    const ledger = wallet === COMPANY_WALLET ? db.company : db.me
    ledger.available += ledger.pending
    ledger.pending = 0n
  } else if (kind === "unwrap" && amount) {
    if (amount > db.me.available) return fail(409, "invalid_confidential_state")
    db.me.available -= amount
  }
  return null
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

// A whole number of at least `min`, the fallback when absent, null when malformed.
function count(raw: string | null, fallback: number, min: number) {
  if (raw === null) return fallback
  if (!/^[0-9]{1,9}$/.test(raw)) return null
  const value = Number(raw)
  return value >= min ? value : null
}

// The cursor is an offset here. A malformed cursor or limit is a bad request;
// a limit past 100 is clamped.
function paged<T>(request: Request, rows: T[]) {
  const url = new URL(request.url)
  const requested = count(url.searchParams.get("limit"), 50, 1)
  const start = count(url.searchParams.get("cursor"), 0, 0)
  if (requested === null || start === null) return fail(400, "invalid_request")
  const limit = Math.min(requested, 100)
  const items = rows.slice(start, start + limit)
  const next = start + limit < rows.length ? String(start + limit) : null
  return HttpResponse.json({ items, next_cursor: next })
}

const newestFirst = (a: MockPayment, b: MockPayment) =>
  b.paidAt.localeCompare(a.paidAt)

const auditorItem = (auditor: MockAuditor) => ({
  id: auditor.id,
  email: auditor.email,
  status: auditorStatus(auditor),
  invited_at: auditor.invitedAt,
})

// RFC 4180 quoting, after a spreadsheet-formula guard: a cell that starts with
// = + - @ tab or CR gets a leading quote so Excel never runs it.
function cell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

function csv(rows: MockPayment[], name: (p: MockPayment) => string) {
  const lines = rows.map((p) =>
    [
      p.paidAt.slice(0, 10),
      name(p),
      formatBaseUnits(p.amount),
      p.status,
      p.signature ?? "",
    ]
      .map(cell)
      .join(","),
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
  runPayment.attempts += 1
  runPayment.status = "pending"
  runPayment.failure = null
  runPayment.receipt = undefined
  return {
    ...p,
    payment_id: runPayment.paymentId,
    person_id: runPayment.personId,
  }
}

// partial-failure: payments 2 and 3 fail on their first attempt only, so a retry
// can be exercised end to end.
const failsFirstAttempt = (payment: MockRunPayment, index: number) =>
  scenarios.has("partial-failure") &&
  (index === 1 || index === 2) &&
  payment.attempts === 1

// A payment that never confirmed outlives its blockhash: payment 3 reports
// `expired` until it is retried.
function reportedStatus(
  payment: MockRunPayment,
  index: number,
): s.PaymentStatus {
  return index === 2 &&
    payment.status === "pending" &&
    failsFirstAttempt(payment, index)
    ? "expired"
    : payment.status
}

function findRunPayment(runId: string, paymentId: string) {
  const run = db.runs.get(runId)
  const index = run?.payments.findIndex((p) => p.paymentId === paymentId) ?? -1
  return { run, index, payment: run?.payments[index] }
}

export const handlers = [
  http.get(at("/health"), async () => {
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
  http.post(at("/wrap"), async ({ request }) => {
    const stopped = await guard(request, undefined, "wrap_rate_limited")
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
      destination: "6xHqMockTokenAccount222222222222222222222222",
      mint: "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb",
      deposit_state: "pending_after_confirmation",
    })
  }),
  http.post(at("/wrap/confirm"), ({ request }) =>
    confirmHandler(request, "wrap"),
  ),

  // ---- Transfer
  http.post(at("/transfer"), async ({ request }) => {
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
  http.post(at("/transfer/confirm"), ({ request }) =>
    confirmHandler(request, "transfer"),
  ),

  // ---- Runs
  http.post(at("/runs"), async ({ request }) => {
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
    const runId = randomUuid()
    const run: NonNullable<ReturnType<typeof db.runs.get>> = {
      id: runId,
      createdAt: new Date().toISOString(),
      payments: data.payments.map<MockRunPayment>((p) => ({
        paymentId: randomUuid(),
        personId: p.person_id,
        amount: BigInt(p.amount),
        status: "pending",
        failure: null,
        signature: null,
        request: "",
        polls: 0,
        attempts: 0,
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

  http.get(at("/runs/:runId"), async ({ request, params }) => {
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
        status: reportedStatus(p, index),
        transparent: false,
        failure: p.failure,
        signature: p.signature,
      })),
    })
  }),

  http.post(
    at("/runs/:runId/payments/:paymentId/confirm"),
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const { data, error } = await parse(request, signatureBody)
      if (error) return error
      const bad = badConfirm(undefined, data.signature)
      if (bad) return bad
      const { run, index, payment } = findRunPayment(
        String(params.runId),
        String(params.paymentId),
      )
      if (!run || !payment) return fail(404, "payment_not_found")
      if (payment.receipt) {
        return replay("run-payment", payment.receipt, data.signature)
      }
      const firstAttempt = failsFirstAttempt(payment, index)
      if (scenarios.has("tx-failed") || firstAttempt) {
        // Payment 3 stays unconfirmed and is reported as expired.
        if (!(firstAttempt && index === 2)) {
          payment.status = "failed"
          payment.failure = "transaction_failed"
        }
        return fail(409, "transaction_failed")
      }
      payment.polls += 1
      payment.status = "signed"
      if (stillPending(payment.polls)) {
        return fail(409, "transaction_not_finalized")
      }
      if (payment.amount > db.company.available) {
        return fail(409, "invalid_confidential_state")
      }
      db.company.available -= payment.amount
      payment.status = "confirmed"
      payment.signature = data.signature
      payment.receipt = receiptFor(payment.request, data.signature)
      if (payment.personId === ME_PERSON) db.me.pending += payment.amount
      db.payments.push({
        id: payment.paymentId,
        runId: run.id,
        personId: payment.personId,
        amount: payment.amount,
        status: "confirmed",
        paidAt: new Date().toISOString(),
        signature: data.signature,
      })
      return HttpResponse.json(payment.receipt)
    },
  ),

  http.post(
    at("/runs/:runId/payments/:paymentId/retry"),
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const { payment, index } = findRunPayment(
        String(params.runId),
        String(params.paymentId),
      )
      if (!payment) return fail(404, "payment_not_found")
      // Only a payment that did not land gets a new transaction: a confirmed
      // one would be paid twice. Mock-only code; the draft contract has none.
      const status = reportedStatus(payment, index)
      if (status !== "failed" && status !== "expired") {
        return fail(409, "payment_not_retryable")
      }
      return HttpResponse.json(runPaymentPrepared(payment))
    },
  ),

  // ---- Unwrap
  http.post(at("/unwrap"), async ({ request }) => {
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
  http.post(at("/unwrap/confirm"), ({ request }) =>
    confirmHandler(request, "unwrap"),
  ),

  // ---- Accounts and keys
  http.post(at("/accounts/configure"), async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.walletRequestSchema)
    if (error) return error
    const p = prepared(data.wallet, 1)
    remember("accounts/configure", p, data.wallet)
    return HttpResponse.json(p)
  }),
  http.post(at("/accounts/configure/confirm"), ({ request }) =>
    confirmHandler(request, "accounts/configure"),
  ),
  http.post(at("/accounts/apply-pending"), async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.walletRequestSchema)
    if (error) return error
    const p = prepared(data.wallet, 1)
    remember("accounts/apply-pending", p, data.wallet)
    return HttpResponse.json(p)
  }),
  http.post(at("/accounts/apply-pending/confirm"), ({ request }) =>
    confirmHandler(request, "accounts/apply-pending"),
  ),
  http.post(at("/keys/enroll"), async ({ request }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const { data, error } = await parse(request, s.enrollRequestSchema)
    if (error) return error
    if (db.enrolled.has(data.wallet)) return fail(409, "key_already_enrolled")
    db.enrolled.add(data.wallet)
    if (data.wallet !== COMPANY_WALLET) db.walletLinked = true
    return HttpResponse.json({ status: "enrolled" })
  }),

  // ---- Reads
  http.get(at("/me/status"), async ({ request }) => {
    const stopped = await guard(request, "recipient", "rate_limited")
    if (stopped) return stopped
    return HttpResponse.json({
      wallet_linked: db.walletLinked,
      key_enrolled: db.enrolled.has(ME_WALLET),
      account_configured: db.accountConfigured,
      pending_credits: db.me.pending > 0n,
    })
  }),
  http.get(at("/me/balance"), async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    return HttpResponse.json({
      available: db.me.available.toString(),
      pending: db.me.pending.toString(),
      as_of_slot: 507_000_000 + db.counter,
    })
  }),
  http.get(at("/me/payments"), async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    const rows = db.payments
      .filter((p) => p.personId === ME_PERSON)
      .sort(newestFirst)
      .map((p) => paymentItem(p, { id: COMPANY_ID, name: "Solaris" }))
    return paged(request, rows)
  }),
  http.get(at("/company/balance"), async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    return HttpResponse.json({
      available: db.company.available.toString(),
      pending: db.company.pending.toString(),
      as_of_slot: 507_000_000 + db.counter,
    })
  }),
  http.get(at("/company/payments"), async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const rows = [...db.payments]
      .sort(newestFirst)
      .map((p) =>
        paymentItem(p, { id: p.personId, name: personName(p.personId) }),
      )
    return paged(request, rows)
  }),
  http.get(at("/company/people/amounts"), async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const rows = [...db.amounts].map(([person_id, amount]) => ({
      person_id,
      amount: amount.toString(),
    }))
    return paged(request, rows)
  }),
  http.put(
    at("/company/people/:personId/amount"),
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const { data, error } = await parse(request, s.setAmountRequestSchema)
      if (error) return error
      const id = String(params.personId)
      if (!db.people.has(id)) return fail(404, "person_not_found")
      db.amounts.set(id, BigInt(data.amount))
      return HttpResponse.json({ person_id: id, amount: data.amount })
    },
  ),
  http.post(
    at("/company/people/:personId/invite"),
    async ({ request, params }) => {
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      if (!db.people.has(String(params.personId))) {
        return fail(404, "person_not_found")
      }
      return HttpResponse.json({
        status: "sent",
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
    },
  ),

  // ---- Auditors (admin only; nothing here carries an amount)
  http.get(at("/company/auditors"), async ({ request }) => {
    const stopped = await guard(request, "admin", "rate_limited")
    if (stopped) return stopped
    const rows = [...db.auditors]
      .sort(
        (a, b) =>
          b.invitedAt.localeCompare(a.invitedAt) || a.id.localeCompare(b.id),
      )
      .map(auditorItem)
    return paged(request, rows)
  }),
  http.post(at("/company/auditors"), async ({ request }) => {
    const stopped = await guard(request, "admin", "rate_limited")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.inviteAuditorRequestSchema)
    if (error) return error
    // An address is the same address whatever its case.
    const email = data.email.toLowerCase()
    const index = db.auditors.findIndex((a) => a.email.toLowerCase() === email)
    const same = db.auditors[index]
    const status = same && auditorStatus(same)
    if (status === "active") return fail(409, "auditor_already_active")
    if (status === "invited") return fail(409, "auditor_already_invited")
    // An expired invite no longer counts: the new one replaces it. The real
    // table's unique index on pending addresses makes that a delete and an insert.
    if (same) db.auditors.splice(index, 1)
    const auditor: MockAuditor = {
      id: randomUuid(),
      email: data.email,
      accepted: false,
      invitedAt: new Date().toISOString(),
    }
    db.auditors.push(auditor)
    return HttpResponse.json(auditorItem(auditor), { status: 201 })
  }),
  // A POST, not a DELETE: the service's CORS allows only GET and POST.
  http.post(
    at("/company/auditors/:auditorId/revoke"),
    async ({ request, params }) => {
      const stopped = await guard(request, "admin", "rate_limited")
      if (stopped) return stopped
      const index = db.auditors.findIndex((a) => a.id === params.auditorId)
      if (index < 0) return fail(404, "auditor_not_found")
      db.auditors.splice(index, 1)
      return HttpResponse.json({ status: "revoked" })
    },
  ),

  // ---- Access log (auditor only): who decrypted what, never an amount
  http.get(at("/audit/access-log"), async ({ request }) => {
    const stopped = await guard(request, "auditor", "rate_limited")
    if (stopped) return stopped
    const rows = [...db.accessLog].sort((a, b) => b.at.localeCompare(a.at))
    return paged(request, rows)
  }),

  http.get(at("/audit/:companyId/payments"), async ({ request, params }) => {
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
  http.get(at("/company/export.csv"), async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    return csv(db.payments, (p) => personName(p.personId))
  }),
  http.get(at("/me/export.csv"), async ({ request }) => {
    const stopped = await guard(request, "recipient")
    if (stopped) return stopped
    return csv(
      db.payments.filter((p) => p.personId === ME_PERSON),
      () => "Solaris",
    )
  }),
  http.get(at("/audit/:companyId/export.csv"), async ({ request, params }) => {
    const stopped = await guard(request, "auditor")
    if (stopped) return stopped
    if (params.companyId !== COMPANY_ID) return fail(404, "not_found")
    return csv(db.payments, (p) => personName(p.personId))
  }),
]
