import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createApiClient } from "./client"
import { ApiError, ContractError, messageFor } from "./errors"
import { base64FromBytes } from "./base64"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_WALLET,
  resetDb,
  seedPeople,
  db,
} from "./mocks/db"
import { scenarios } from "./mocks/scenario"
import { server } from "./mocks/server"
import {
  ConfirmTimeoutError,
  UnexpectedSignerError,
  signAndConfirm,
  type Signer,
} from "./sign"

const BASE = "http://mock.cadence.test"

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
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
const submit = async () => "5SigMockSignature1111111111111111111111111111"
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
    ).rejects.toThrow()
    await expect(
      // @ts-expect-error amounts are strings of base units, never numbers
      api.wrap.prepare({ company_wallet: COMPANY_WALLET, amount: 1000000 }),
    ).rejects.toThrow()
  })

  it("accepts exactly 2^48-1 base units and refuses one more", async () => {
    const ok = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "281474976710655",
    })
    expect(ok.transaction_version).toBe(0)
    await expect(
      api.wrap.prepare({
        company_wallet: COMPANY_WALLET,
        amount: "281474976710656",
      }),
    ).rejects.toThrow()
  })

  it("fails loudly when a response drifts from the contract", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(
      http.get("*/me/balance", () => HttpResponse.json({ available: 12.5 })),
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
      http.get("*/me/balance", () =>
        HttpResponse.json({ error: "brand_new_code" }, { status: 409 }),
      ),
    )
    const error = (await caught(api.me.balance())) as ApiError
    expect(error.code).toBe("brand_new_code")
    expect(messageFor(error)).toBe("Something went wrong. Try again.")
  })

  it("reports a network failure as retryable", async () => {
    const { http, HttpResponse } = await import("msw")
    server.use(http.get("*/me/balance", () => HttpResponse.error()))
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({ code: "network_error" })
    expect(error.isRetryable).toBe(true)
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
    const request = { request_id: prepared.request_id, signature: "sig" }
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

  it("gives up on a transaction that never finalizes", async () => {
    const slept: number[] = []
    const error = await caught(
      signAndConfirm(
        {
          transaction: base64FromBytes(Uint8Array.of(1, 2, 3)),
          required_signers: [COMPANY_WALLET],
        },
        {
          signer,
          submit,
          sleep: async (ms) => {
            slept.push(ms)
          },
          confirm: async () => {
            throw new ApiError(409, "transaction_not_finalized")
          },
        },
      ),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    // Backs off from 2 s toward 10 s and stops at about a minute.
    expect(slept[0]).toBe(2_000)
    expect(slept.at(-1)).toBe(10_000)
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000)
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
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        sleep: noSleep,
        confirm: (signature) =>
          api.transfer.confirm({ request_id: prepared.request_id, signature }),
      }),
    )
    expect(error).toMatchObject({ status: 409, code: "transaction_failed" })
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
    const prepared = await api.accounts.applyPending(ME_WALLET)
    await api.accounts.confirmApplyPending({
      request_id: prepared.request_id,
      signature: "sig",
    })
    expect(db.me.pending).toBe(0n)

    scenarios.set("instant", "credit-mismatch")
    const next = await api.accounts.applyPending(ME_WALLET)
    const error = await caught(
      api.accounts.confirmApplyPending({
        request_id: next.request_id,
        signature: "sig",
      }),
    )
    expect(error).toMatchObject({ code: "credit_counter_mismatch" })
  })

  it("enrolls a key once", async () => {
    await api.keys.enroll(ME_WALLET, "signature")
    expect(await caught(api.keys.enroll(ME_WALLET, "signature"))).toMatchObject(
      {
        code: "key_already_enrolled",
      },
    )
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
    for (const payment of run.payments) {
      await api.runs.confirmPayment(
        run.run_id,
        payment.payment_id,
        `sig-${payment.payment_id}`,
      )
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
    await api.runs.confirmPayment(run.run_id, first.payment_id, "sig-1")
    expect(
      await caught(
        api.runs.confirmPayment(run.run_id, second.payment_id, "sig-2"),
      ),
    ).toMatchObject({
      code: "transaction_failed",
    })
    expect(
      await caught(
        api.runs.confirmPayment(run.run_id, third.payment_id, "sig-3"),
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

  it("flags a near match within 1%", async () => {
    const ok = await unwrap("4190000000", true)
    expect(ok.reveal_risk.level).toBe("near")
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
})
