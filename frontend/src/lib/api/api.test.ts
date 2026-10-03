import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ZodError } from "zod"
import { createApiClient } from "./client"
import { ApiError, ContractError, messageFor } from "./errors"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_WALLET,
  resetDb,
  seedPeople,
  db,
} from "./mocks/db"
import { scenarios, timing } from "./mocks/scenario"
import { server } from "./mocks/server"
import { UnexpectedSignerError, signAndConfirm, type Signer } from "./sign"

const BASE = "http://mock.cadence.test"

// Every request that reaches the mock, so a test can prove none was sent.
const requests: string[] = []

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" })
  server.events.on("request:start", ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`)
  })
})
afterEach(() => {
  requests.length = 0
  timing.slowMs = 1500
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: BASE,
  getToken: async () => "test-token",
})
const signedOut = createApiClient({ baseUrl: BASE, getToken: async () => null })

const signer: Signer = {
  address: COMPANY_WALLET,
  signTransaction: async (bytes) => Uint8Array.from([...bytes, 1]),
}
const SIG = "5SigMockSignature1111111111111111111111111111"
const submit = async () => SIG
// Distinct, valid-looking base58 signatures.
// (No 0 in base58: the digit becomes a letter.)
const sigOf = (n: number) => `TestSignature${"abcdefghij"[n]}`.padEnd(64, "1")
const noSleep = async () => {}

// A thrown ApiError, so a test can read its code.
async function caught(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the call to fail")
}

describe("contract validation", () => {
  it("refuses a float or number amount before sending", async () => {
    await expect(
      api.wrap.prepare({ company_wallet: COMPANY_WALLET, amount: "1.5" }),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      // @ts-expect-error amounts are strings of base units, never numbers
      api.wrap.prepare({ company_wallet: COMPANY_WALLET, amount: 1000000 }),
    ).rejects.toBeInstanceOf(ZodError)
    // Not one request reached the mock.
    expect(requests).toEqual([])
  })

  it("accepts exactly 2^48-1 base units and refuses one more", async () => {
    const ok = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "281474976710655",
    })
    expect(ok.transaction_version).toBe(0)
    expect(requests).toEqual(["POST /wrap"])
    await expect(
      api.wrap.prepare({
        company_wallet: COMPANY_WALLET,
        amount: "281474976710656",
      }),
    ).rejects.toBeInstanceOf(ZodError)
    expect(requests).toEqual(["POST /wrap"])
  })

  it("fails loudly when a response drifts from the contract", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(
      http.get(`${BASE}/me/balance`, () =>
        HttpResponse.json({ available: 12.5 }),
      ),
    )
    expect(await caught(api.me.balance())).toBeInstanceOf(ContractError)
  })
})

describe("authentication and errors", () => {
  it("does not call the service without a token", async () => {
    const error = await caught(signedOut.me.balance())
    expect(error).toMatchObject({
      status: 401,
      code: "authentication_required",
    })
    expect(requests).toEqual([])
  })

  it("reads the error code and nothing else", async () => {
    scenarios.set("unauthenticated")
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe("authentication_required")
    expect(messageFor(error)).toMatch(/sign in/i)
  })

  it("surfaces Retry-After on a 429 and marks it retryable", async () => {
    scenarios.set("rate-limited")
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({
      status: 429,
      code: "transfer_rate_limited",
      retryAfter: 60,
    })
    expect(error.isRetryable).toBe(true)
  })

  it("treats auth_unavailable as retryable, not as signed out", async () => {
    scenarios.set("service-down")
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({ status: 503, code: "auth_unavailable" })
    expect(error.isRetryable).toBe(true)
  })

  it("handles an unknown code as its status class", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(
      http.get(`${BASE}/me/balance`, () =>
        HttpResponse.json({ error: "brand_new_code" }, { status: 409 }),
      ),
    )
    const error = (await caught(api.me.balance())) as ApiError
    expect(error.code).toBe("brand_new_code")
    expect(messageFor(error)).toBe("Something went wrong. Try again.")
  })

  it("reports a network failure as retryable", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(http.get(`${BASE}/me/balance`, () => HttpResponse.error()))
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({ code: "network_error" })
    expect(error.isRetryable).toBe(true)
  })

  it("treats a 502 from a proxy as retryable", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(
      http.get(`${BASE}/me/balance`, () =>
        HttpResponse.text("<html>Bad gateway</html>", { status: 502 }),
      ),
    )
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({ status: 502, code: "service_unavailable" })
    expect(error.isRetryable).toBe(true)
  })

  it("answers service-down on confirm with a retryable 503 that signAndConfirm outlasts", async () => {
    scenarios.set("instant")
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "1000000",
    })
    scenarios.set("instant", "service-down")
    const error = (await caught(
      api.wrap.confirm({ request_id: prepared.request_id, signature: SIG }),
    )) as ApiError
    expect(error).toMatchObject({ status: 503, code: "auth_unavailable" })
    expect(error.isRetryable).toBe(true)
    expect(db.company.pending).toBe(0n)

    // The service comes back while signAndConfirm is waiting.
    let confirms = 0
    const receipt = await signAndConfirm(prepared, {
      signer,
      submit,
      sleep: async () => scenarios.set("instant"),
      confirm: (signature) => {
        confirms++
        return api.wrap.confirm({ request_id: prepared.request_id, signature })
      },
    })
    expect(receipt.status).toBe("finalized")
    expect(confirms).toBe(2)
    expect(db.company.pending).toBe(1_000_000n)
  })

  it("keeps a role out of other roles' routes", async () => {
    db.role = "recipient"
    const error = await caught(api.company.payments())
    expect(error).toMatchObject({ status: 403, code: "forbidden_role" })
  })
})

describe("prepare, sign, confirm", () => {
  it("wraps: signs the exact bytes and confirms after 'not finalized' twice", async () => {
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "2500000000",
    })
    let confirms = 0
    const steps: string[] = []
    const receipt = await signAndConfirm(prepared, {
      signer,
      submit,
      sleep: noSleep,
      onStep: (step) => steps.push(step),
      confirm: (signature) => {
        confirms++
        return api.wrap.confirm({ request_id: prepared.request_id, signature })
      },
    })
    expect(receipt.status).toBe("finalized")
    expect(confirms).toBe(3)
    expect(steps).toEqual(["signing", "submitting", "confirming"])
    // The wrap lands in the pending balance, not the available one.
    expect(db.company.pending).toBe(2_500_000_000n)
  })

  it("returns the same receipt when a confirm is repeated", async () => {
    scenarios.set("instant")
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "1000000",
    })
    const request = { request_id: prepared.request_id, signature: SIG }
    const first = await api.wrap.confirm(request)
    expect(await api.wrap.confirm(request)).toEqual(first)
    expect(db.company.pending).toBe(1_000_000n)
  })

  it("never signs for a key that is not the user's", async () => {
    const prepared = await api.wrap.prepare({
      company_wallet: ME_WALLET,
      amount: "1000000",
    })
    let signed = false
    const error = await caught(
      signAndConfirm(prepared, {
        signer: {
          address: COMPANY_WALLET,
          signTransaction: async (bytes) => {
            signed = true
            return bytes
          },
        },
        submit,
        confirm: async () => {
          throw new Error("unreachable")
        },
      }),
    )
    expect(error).toBeInstanceOf(UnexpectedSignerError)
    expect(signed).toBe(false)
  })

  it("stops at once on a final failure", async () => {
    scenarios.set("tx-failed")
    const prepared = await api.transfer.prepare({
      company_wallet: COMPANY_WALLET,
      sender: COMPANY_WALLET,
      recipient: ME_WALLET,
      amount: "4200000000",
      aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    })
    expect(prepared.transaction_version).toBe(1)
    let confirms = 0
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        sleep: noSleep,
        confirm: (signature) => {
          confirms++
          return api.transfer.confirm({
            request_id: prepared.request_id,
            signature,
          })
        },
      }),
    )
    expect(error).toMatchObject({ status: 409, code: "transaction_failed" })
    expect(confirms).toBe(1)
    expect(requests.filter((r) => r === "POST /transfer/confirm")).toHaveLength(
      1,
    )
  })

  it("asks for the activation artifacts when setup is missing", async () => {
    scenarios.set("setup-required")
    const error = await caught(
      api.wrap.prepare({ company_wallet: COMPANY_WALLET, amount: "1000000" }),
    )
    expect(error).toMatchObject({ code: "confidential_setup_required" })
    const ok = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "1000000",
      setup: {
        pubkey_validity_proof: "AAAA",
        decryptable_zero_balance: "AAAA",
      },
    })
    expect(ok.deposit_state).toBe("pending_after_confirmation")
  })

  it("apply-pending moves pending to available, and reports a counter mismatch", async () => {
    scenarios.set("instant")
    db.me.pending = 3_000_000n
    const before = db.me.available
    const prepared = await api.accounts.applyPending(ME_WALLET)
    await api.accounts.confirmApplyPending({
      request_id: prepared.request_id,
      signature: SIG,
    })
    expect(db.me.pending).toBe(0n)
    expect(db.me.available).toBe(before + 3_000_000n)

    scenarios.set("instant", "credit-mismatch")
    const next = await api.accounts.applyPending(ME_WALLET)
    const error = await caught(
      api.accounts.confirmApplyPending({
        request_id: next.request_id,
        signature: SIG,
      }),
    )
    expect(error).toMatchObject({ code: "credit_counter_mismatch" })
  })

  it("enrolls a key once", async () => {
    await api.keys.enroll(ME_WALLET, SIG)
    expect(await caught(api.keys.enroll(ME_WALLET, SIG))).toMatchObject({
      code: "key_already_enrolled",
    })
  })
})

describe("payroll runs", () => {
  const [bruno, mariana, diego] = seedPeople
  const request = (ids: string[]) => ({
    company_wallet: COMPANY_WALLET,
    payments: ids.map((person_id) => ({ person_id, amount: "1000000000" })),
    idempotency_key: crypto.randomUUID(),
  })

  it("returns one transaction per recipient, in order, and the same run for the same key", async () => {
    const body = request([bruno.id, diego.id])
    const run = await api.runs.create(body)
    expect(run.payments.map((p) => p.person_id)).toEqual([bruno.id, diego.id])
    expect(new Set(run.payments.map((p) => p.request_id)).size).toBe(2)
    expect(await api.runs.create(body)).toEqual(run)
  })

  it("replays a key whose first create failed as a fresh create, then as the same run", async () => {
    const body = request([bruno.id, mariana.id])
    expect(await caught(api.runs.create(body))).toMatchObject({
      code: "recipient_not_activated",
    })
    // The failed call stored nothing under the key.
    expect(db.runs.size).toBe(0)
    const fixed = { ...body, payments: [body.payments[0]] }
    const run = await api.runs.create(fixed)
    expect(run.payments).toHaveLength(1)
    expect(await api.runs.create(fixed)).toEqual(run)
    expect(db.runs.size).toBe(1)
  })

  it("refuses people who have not activated", async () => {
    const error = await caught(api.runs.create(request([bruno.id, mariana.id])))
    expect(error).toMatchObject({
      status: 409,
      code: "recipient_not_activated",
    })
  })

  it("runs three payments and each reports its own status", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(
      request([bruno.id, diego.id, seedPeople[3].id]),
    )
    for (const [i, payment] of run.payments.entries()) {
      await api.runs.confirmPayment(run.run_id, payment.payment_id, sigOf(i))
    }
    const status = await api.runs.get(run.run_id)
    expect(status.payments.map((p) => p.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ])
    // The status has no amount anywhere.
    expect(JSON.stringify(status)).not.toMatch(/amount/)
  })

  it("one failure does not block the rest, and a retry prepares only that payment", async () => {
    scenarios.set("instant", "partial-failure")
    const run = await api.runs.create(
      request([bruno.id, diego.id, seedPeople[3].id]),
    )
    const [first, second, third] = run.payments
    await api.runs.confirmPayment(run.run_id, first.payment_id, sigOf(1))
    expect(
      await caught(
        api.runs.confirmPayment(run.run_id, second.payment_id, sigOf(2)),
      ),
    ).toMatchObject({
      code: "transaction_failed",
    })
    expect(
      await caught(
        api.runs.confirmPayment(run.run_id, third.payment_id, sigOf(3)),
      ),
    ).toMatchObject({
      code: "transaction_failed",
    })

    const status = await api.runs.get(run.run_id)
    expect(status.payments.map((p) => p.status)).toEqual([
      "confirmed",
      "failed",
      "expired",
    ])
    expect(status.payments[1].failure).toBe("transaction_failed")

    const retry = await api.runs.retryPayment(run.run_id, second.payment_id)
    expect(retry.payment_id).toBe(second.payment_id)
    expect(retry.request_id).not.toBe(second.request_id)
  })
})

describe("unwrap and the reveal-risk flag", () => {
  const unwrap = (amount: string, acknowledge = false) =>
    api.unwrap.prepare({
      wallet: ME_WALLET,
      amount,
      acknowledge_reveal_risk: acknowledge,
    })

  it("flags an amount equal to one received, and needs an acknowledgement", async () => {
    expect(await caught(unwrap("4200000000"))).toMatchObject({
      status: 409,
      code: "reveal_risk_not_acknowledged",
    })
    const ok = await unwrap("4200000000", true)
    expect(ok.reveal_risk.level).toBe("exact")
    expect(ok.reveal_risk.matches).toHaveLength(1)
    // Matches name payments and dates, never an amount.
    expect(JSON.stringify(ok.reveal_risk)).not.toMatch(/amount|4200/)
  })

  it("flags a near match within 1%, and needs an acknowledgement for it too", async () => {
    expect(await caught(unwrap("4190000000"))).toMatchObject({
      status: 409,
      code: "reveal_risk_not_acknowledged",
    })
    const ok = await unwrap("4190000000", true)
    expect(ok.reveal_risk.level).toBe("near")
    expect(ok.reveal_risk.matches).toHaveLength(1)
  })

  // 1% of 4,200 USDC is 42,000,000 base units, on both sides of the payment.
  it.each([
    ["4158000000", "near"],
    ["4242000000", "near"],
    ["4157999999", "none"],
    ["4242000001", "none"],
  ])("puts %s at %s", async (amount, level) => {
    const prepared = await unwrap(amount, true)
    expect(prepared.reveal_risk.level).toBe(level)
    // Without an acknowledgement only the risky ones are stopped.
    const plain = expect(unwrap(amount))
    if (level === "none") {
      await plain.resolves.toMatchObject({ reveal_risk: { level: "none" } })
    } else {
      await plain.rejects.toMatchObject({
        code: "reveal_risk_not_acknowledged",
      })
    }
  })

  it("lets a safe amount through without a flag", async () => {
    const ok = await unwrap("1234567", false)
    expect(ok.reveal_risk).toEqual({ level: "none", matches: [] })
  })

  it("refuses more than the available balance", async () => {
    expect(await caught(unwrap("9000000000", true))).toMatchObject({
      code: "invalid_confidential_state",
    })
  })
})

describe("reads and exports", () => {
  it("pages through payments, newest first", async () => {
    const first = await api.company.payments({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.next_cursor).not.toBeNull()
    const rest = await api.company.payments({
      limit: 2,
      cursor: first.next_cursor!,
    })
    expect(rest.items).toHaveLength(2)
    expect(rest.next_cursor).toBeNull()
    const dates = [...first.items, ...rest.items].map((p) => p.paid_at)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it("returns the recipient's own balance as base-unit strings", async () => {
    const balance = await api.me.balance()
    expect(balance).toMatchObject({ available: "8000000000", pending: "0" })
  })

  it("sets and reads a roster amount", async () => {
    await api.company.setAmount(seedPeople[1].id, "5000000000")
    const { items } = await api.company.amounts()
    expect(items.find((i) => i.person_id === seedPeople[1].id)?.amount).toBe(
      "5000000000",
    )
    expect(
      await caught(api.company.setAmount(crypto.randomUUID(), "1000000")),
    ).toMatchObject({
      code: "person_not_found",
    })
  })

  it("keeps an auditor's grant to one company", async () => {
    db.role = "auditor"
    expect((await api.audit.payments(COMPANY_ID)).items.length).toBeGreaterThan(
      0,
    )
    expect(await caught(api.audit.payments(crypto.randomUUID()))).toMatchObject(
      {
        status: 404,
      },
    )
  })

  it("downloads a CSV as a Blob through the authenticated client", async () => {
    const blob = await api.exports.company()
    const text = await blob.text()
    expect(text.split("\n")[0]).toBe(
      "date,counterparty,amount,status,signature",
    )
    expect(text).toContain("Bruno Costa,4200,confirmed")
  })

  it("sends an invite and answers the health check without a token", async () => {
    expect((await api.company.invite(seedPeople[1].id)).status).toBe("sent")
    expect((await signedOut.health()).status).toBe("ok")
  })

  it("does not invite someone who is not on the roster", async () => {
    expect(await caught(api.company.invite(crypto.randomUUID()))).toMatchObject(
      { status: 404, code: "person_not_found" },
    )
  })

  it("reports an unavailable service from /health as data, not an error", async () => {
    scenarios.set("service-down")
    expect(await signedOut.health()).toMatchObject({
      status: "unavailable",
      rpc_reachable: false,
    })
  })

  it("reads the company balance", async () => {
    expect(await api.company.balance()).toMatchObject({
      available: "84000000000",
      pending: "0",
    })
  })

  it("delays every response under the slow scenario", async () => {
    timing.slowMs = 40
    scenarios.set("slow")
    const start = performance.now()
    await api.me.balance()
    const slow = performance.now() - start
    // Timers do not fire early, bar a millisecond of rounding.
    expect(slow).toBeGreaterThanOrEqual(39)
    // The delay is applied to the confirm routes too, before any check.
    const confirm = performance.now()
    await caught(
      api.wrap.confirm({ request_id: "a".repeat(64), signature: SIG }),
    )
    expect(performance.now() - confirm).toBeGreaterThanOrEqual(39)
  })
})
