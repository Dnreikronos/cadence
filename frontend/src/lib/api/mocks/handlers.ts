import { http, HttpResponse, delay } from "msw"
import { z } from "zod"
import { formatUsdcFixed } from "@/lib/deposit/schema"
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
  type MockRun,
  type MockRunPayment,
} from "./db"
import {
  MOCK_BLOCKHASH_LIFETIME,
  mockBlockHeight,
  mockTokenAccount,
} from "./chain"
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
//
// `rateLimitCode` is the generic `rate_limited` unless the route prepares a payment:
// those answer with their limiter's own code (the contract's rate limit row), reads and
// the account, auditor and invite routes do not.
async function guard(
  request: Request,
  role?: Role,
  rateLimitCode = "rate_limited",
) {
  if (scenarios.has("slow")) await delay(timing.slowMs)
  if (scenarios.has("auth-down")) return fail(503, "auth_unavailable")
  if (scenarios.has("service-down")) return fail(503, "service_unavailable")
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

// An unwrap body is checked for shape here. The balance key and the link get their own
// codes below, as the real service answers them (`unwrap.rs`, `transfer_store.rs`).
const unwrapBody = s.unwrapRequestSchema.extend({
  aes_key: z.string(),
  wallet_signature: z.string().nullish(),
})

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
  const rejected = applyEffect(kind, record.wallet, record.amount)
  if (rejected) return rejected
  record.receipt = receiptFor(data.request_id, data.signature)
  // The service compares the credit counter after the apply, so this answer can
  // come for an apply that did land: confirming the same signature again returns
  // its receipt.
  if (kind === "accounts/apply-pending" && scenarios.has("credit-mismatch")) {
    return fail(409, "credit_counter_mismatch")
  }
  return HttpResponse.json(record.receipt)
}

// What a finalized transaction does to the ledgers. A ledger never goes
// negative: a confirm that would is refused, and changes nothing.
function applyEffect(kind: string, wallet: string, amount?: bigint) {
  if (kind === "wrap" && amount) {
    if (amount > db.publicUsdc) return fail(409, "insufficient_usdc")
    db.publicUsdc -= amount
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

// Every line, the last one too, ends in CRLF.
function csv(rows: MockPayment[], name: (p: MockPayment) => string) {
  const lines = rows.map((p) =>
    [
      p.paidAt.slice(0, 10),
      name(p),
      formatUsdcFixed(p.amount),
      p.status,
      p.signature ?? "",
    ]
      .map(cell)
      .join(","),
  )
  return new HttpResponse(
    ["date,counterparty,amount,status,signature", ...lines]
      .map((line) => `${line}\r\n`)
      .join(""),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
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

// docs/dev/RUNS_API.md: positions, token accounts, a batch confirm with per-position
// errors, and a run-level retry. No role check and no idempotency, like the service.

// Who a token account belongs to: an activated person of the company, or no one.
function personOfAccount(account: string) {
  return (
    seedPeople.find(
      (person) => person.activated && mockTokenAccount(person.id) === account,
    )?.id ?? null
  )
}

const liveAt = (payment: MockRunPayment, height: number) =>
  payment.lastValidBlockHeight !== undefined &&
  height <= payment.lastValidBlockHeight

// partial-failure: position 1 is rejected by the network on its first attempt.
// prepare-failed: position 1 cannot be prepared on its first attempt.
const rejectsFirst = (payment: MockRunPayment) =>
  scenarios.has("partial-failure") &&
  payment.position === 1 &&
  payment.attempt === 0
const cannotPrepare = (payment: MockRunPayment) =>
  scenarios.has("prepare-failed") &&
  payment.position === 1 &&
  payment.attempt === 0

// A new attempt for a position: prepared with a fresh transaction, or
// `preparation_failed` with no transaction when its account cannot be paid.
function prepareAttempt(payment: MockRunPayment, attempt: number) {
  Object.assign(payment, {
    attempt,
    signature: null,
    slot: null,
    polls: 0,
    transaction: undefined,
    lastValidBlockHeight: undefined,
  })
  if (payment.personId === null || cannotPrepare(payment)) {
    payment.status = "preparation_failed"
    payment.requestId = null
    payment.error =
      payment.personId === null
        ? "invalid_confidential_state"
        : "proof_generation_failed"
    return
  }
  const p = prepared(COMPANY_WALLET)
  payment.status = "prepared"
  payment.requestId = p.request_id
  payment.error = null
  payment.transaction = p.transaction
  payment.lastValidBlockHeight = mockBlockHeight() + MOCK_BLOCKHASH_LIFETIME
}

// The run as the service answers it. `withTransactions` lists the positions whose
// transaction is returned: those prepared in this call.
function runBody(
  run: MockRun,
  withTransactions: ReadonlySet<number> = new Set(),
  errors: { position: number; error: string }[] = [],
) {
  const statuses = run.payments.map((p) => p.status)
  return {
    run_id: run.id,
    company_wallet: run.companyWallet,
    sender: run.sender,
    mint: "CGL4U4VC8arAEUDxLh7c6K4rJnZr1T6faK9QQRn2sYmb",
    transaction_version: 1,
    required_signers: [run.companyWallet],
    status: statuses.every((status) => status === "finalized")
      ? "completed"
      : statuses.some((status) =>
            ["failed", "expired", "preparation_failed"].includes(status),
          )
        ? "partial_failure"
        : "prepared",
    payments: run.payments.map((p) => ({
      position: p.position,
      destination: p.destination,
      attempt: p.attempt,
      request_id: p.requestId,
      status: p.status,
      signature: p.signature,
      slot: p.slot,
      error: p.error,
      ...(withTransactions.has(p.position) && p.status === "prepared"
        ? {
            transaction: p.transaction,
            last_valid_block_height: p.lastValidBlockHeight,
          }
        : {}),
    })),
    ...(errors.length ? { errors } : {}),
  }
}

// One confirm item: the item error, or null once the outcome is recorded.
function confirmPosition(
  run: MockRun,
  item: { position: number; request_id: string; signature: string },
): string | null {
  const payment = run.payments.find((p) => p.position === item.position)
  if (!payment) return "invalid_payment"
  if (payment.status === "finalized" || payment.status === "failed") {
    // A recorded outcome is idempotent for the same attempt and signature.
    return payment.requestId === item.request_id &&
      payment.signature === item.signature
      ? null
      : "payment_already_resolved"
  }
  if (payment.status !== "prepared") return "payment_not_prepared"
  if (payment.requestId !== item.request_id) return "payment_attempt_changed"
  if (scenarios.has("tx-failed") || rejectsFirst(payment)) {
    payment.status = "failed"
    payment.error = "transaction_failed"
    payment.signature = item.signature
    payment.slot = 507_000_000 + nextId()
    return null
  }
  payment.polls += 1
  if (stillPending(payment.polls)) return "transaction_not_finalized"
  // The proof was built for the balance as it stood: one that no longer covers the
  // amount fails on the network.
  if (payment.amount > db.company.available) {
    payment.status = "failed"
    payment.error = "transaction_failed"
  } else {
    db.company.available -= payment.amount
    payment.status = "finalized"
    if (payment.personId === ME_PERSON) db.me.pending += payment.amount
    db.payments.push({
      id: randomUuid(),
      runId: run.id,
      personId: payment.personId ?? "",
      amount: payment.amount,
      status: "confirmed",
      paidAt: new Date().toISOString(),
      signature: item.signature,
    })
  }
  payment.signature = item.signature
  payment.slot = 507_000_000 + nextId()
  return null
}

export const handlers = [
  // A service that is down does not answer its health check either; one that is up
  // but cannot reach the Solana RPC answers `unavailable`, as the real one does.
  http.get(at("/health"), async () => {
    if (scenarios.has("slow")) await delay(timing.slowMs)
    if (scenarios.has("service-down")) return fail(503, "service_unavailable")
    if (scenarios.has("rpc-down")) {
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
    // Like the real service, refuse what the USDC account cannot cover. Confirm
    // checks again, since the balance can fall in between.
    if (BigInt(data.amount) > db.publicUsdc) {
      return fail(409, "insufficient_usdc")
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
    const stopped = await guard(request, undefined, "transfer_rate_limited")
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
    const stopped = await guard(request, undefined, "transfer_rate_limited")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.runRequestSchema)
    if (error) return error
    const recipients = data.payments.map((p) => p.recipient)
    if (
      new Set(recipients).size !== recipients.length ||
      recipients.includes(data.sender)
    ) {
      return fail(400, "invalid_payments")
    }
    if (!db.linkedWallets.has(data.company_wallet)) {
      if (!data.wallet_signature) return fail(409, "wallet_link_required")
      db.linkedWallets.add(data.company_wallet)
    }
    if (data.sender !== mockTokenAccount(data.company_wallet)) {
      return fail(403, "wallet_access_denied")
    }
    const run: MockRun = {
      id: randomUuid(),
      companyWallet: data.company_wallet,
      sender: data.sender,
      payments: data.payments.map((p, position) => ({
        position,
        destination: p.recipient,
        personId: personOfAccount(p.recipient),
        amount: BigInt(p.amount),
        attempt: 0,
        requestId: null,
        status: "prepared",
        signature: null,
        slot: null,
        error: null,
        polls: 0,
      })),
    }
    for (const payment of run.payments) prepareAttempt(payment, 0)
    db.runs.set(run.id, run)
    return HttpResponse.json(
      runBody(run, new Set(run.payments.map((p) => p.position))),
    )
  }),

  http.get(at("/runs/:runId"), async ({ request, params }) => {
    const stopped = await guard(request)
    if (stopped) return stopped
    const run = db.runs.get(String(params.runId))
    if (!run) return fail(404, "run_not_found")
    return HttpResponse.json(runBody(run))
  }),

  http.post(at("/runs/:runId/confirm"), async ({ request, params }) => {
    const stopped = await guard(request, undefined, "transfer_rate_limited")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.runConfirmRequestSchema)
    if (error) return error
    const run = db.runs.get(String(params.runId))
    if (!run) return fail(404, "run_not_found")
    const positions = data.payments.map((p) => p.position)
    if (new Set(positions).size !== positions.length) {
      return fail(400, "invalid_payments")
    }
    const errors = data.payments.flatMap((item) => {
      const code = confirmPosition(run, item)
      return code ? [{ position: item.position, error: code }] : []
    })
    return HttpResponse.json(runBody(run, new Set(), errors))
  }),

  http.post(at("/runs/:runId/retry"), async ({ request, params }) => {
    const stopped = await guard(request, undefined, "transfer_rate_limited")
    if (stopped) return stopped
    const { data, error } = await parse(request, s.runRetryRequestSchema)
    if (error) return error
    const run = db.runs.get(String(params.runId))
    if (!run) return fail(404, "run_not_found")
    const asked = new Map(data.payments.map((p) => [p.position, p]))
    if (
      asked.size !== data.payments.length ||
      [...asked.keys()].some((position) => !run.payments[position])
    ) {
      return fail(400, "invalid_payments")
    }
    const height = mockBlockHeight()
    // Every live prepared position must come with its original signature. The mock
    // cannot see the network: a live one that was signed has not landed yet.
    for (const payment of run.payments) {
      if (payment.status !== "prepared" || !liveAt(payment, height)) continue
      const item = asked.get(payment.position)
      if (!item) return fail(409, "outstanding_payments")
      if (!item.signature) return fail(409, "original_signature_required")
      return fail(409, "transaction_not_finalized")
    }
    const errors: { position: number; error: string }[] = []
    const rebuilt = new Set<number>()
    for (const payment of run.payments) {
      if (payment.status === "prepared") {
        // Expired with no history: unresolved, never rebuilt.
        errors.push({
          position: payment.position,
          error: "transaction_history_unavailable",
        })
        continue
      }
      const item = asked.get(payment.position)
      if (!item || payment.status === "finalized") continue
      payment.amount = BigInt(item.amount)
      prepareAttempt(payment, payment.attempt + 1)
      rebuilt.add(payment.position)
    }
    return HttpResponse.json(runBody(run, rebuilt, errors))
  }),

  // ---- Unwrap
  http.post(at("/unwrap"), async ({ request }) => {
    const stopped = await guard(request, "recipient", "transfer_rate_limited")
    if (stopped) return stopped
    const { data, error } = await parse(request, unwrapBody)
    if (error) return error
    if (!s.unwrapRequestSchema.shape.aes_key.safeParse(data.aes_key).success) {
      return fail(400, "invalid_balance_key")
    }
    // Linked as on a run, before the balance or the risk is looked at. A linked wallet's
    // signature is not looked at; one that is not a signature does not link.
    if (!db.linkedWallets.has(data.wallet)) {
      if (data.wallet_signature == null)
        return fail(409, "wallet_link_required")
      if (!s.signatureSchema.safeParse(data.wallet_signature).success) {
        return fail(403, "wallet_access_denied")
      }
      db.linkedWallets.add(data.wallet)
    }
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
    const stopped = await guard(request, undefined, "transfer_rate_limited")
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
    const stopped = await guard(request, undefined, "transfer_rate_limited")
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
    const stopped = await guard(request, "recipient")
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
  // Proposed (API_CONTRACT Q36): an activated person has a token account.
  http.get(at("/company/people/accounts"), async ({ request }) => {
    const stopped = await guard(request, "admin")
    if (stopped) return stopped
    const rows = [...db.people].map((person_id) => ({
      person_id,
      token_account: seedPeople.some((p) => p.id === person_id && p.activated)
        ? mockTokenAccount(person_id)
        : null,
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
    const stopped = await guard(request, "admin")
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
    const stopped = await guard(request, "admin")
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
      const stopped = await guard(request, "admin")
      if (stopped) return stopped
      const index = db.auditors.findIndex((a) => a.id === params.auditorId)
      if (index < 0) return fail(404, "auditor_not_found")
      db.auditors.splice(index, 1)
      return HttpResponse.json({ status: "revoked" })
    },
  ),

  // ---- Access log (auditor only): who decrypted what, never an amount
  http.get(at("/audit/access-log"), async ({ request }) => {
    const stopped = await guard(request, "auditor")
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
