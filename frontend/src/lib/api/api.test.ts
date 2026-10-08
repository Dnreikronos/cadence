import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { ZodError } from "zod"
import { createApiClient } from "./client"
import { ApiError, ContractError, messageFor } from "./errors"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_WALLET,
  resetAccountStatus,
  resetDb,
  seedPeople,
  db,
} from "./mocks/db"
import { scenarios, timing } from "./mocks/scenario"
import { server } from "./mocks/server"
import { expectNoAmount } from "./no-amount"
import { accessActions, accessActorKinds, isSignable } from "./schemas"
import { mockTokenAccount } from "./mocks/chain"
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
    // The wallet has to hold what it wraps, so give it the cap.
    db.publicUsdc = 281474976710655n
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
      code: "rate_limited",
      retryAfter: 60,
    })
    expect(error.isRetryable).toBe(true)
  })

  it("keeps the limiter's own code on the routes that prepare a payment", async () => {
    scenarios.set("rate-limited")
    expect(
      await caught(
        api.wrap.prepare({ company_wallet: COMPANY_WALLET, amount: "1000000" }),
      ),
    ).toMatchObject({ status: 429, code: "wrap_rate_limited" })
    expect(
      await caught(
        api.transfer.prepare({
          company_wallet: COMPANY_WALLET,
          sender: COMPANY_WALLET,
          recipient: ME_WALLET,
          amount: "1000000",
          aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
        }),
      ),
    ).toMatchObject({ status: 429, code: "transfer_rate_limited" })
  })

  it("answers a service-down read with a generic, retryable 503", async () => {
    scenarios.set("service-down")
    const error = (await caught(api.me.balance())) as ApiError
    expect(error).toMatchObject({ status: 503, code: "service_unavailable" })
    expect(error.isRetryable).toBe(true)
  })

  it("treats auth_unavailable as retryable, not as signed out", async () => {
    scenarios.set("auth-down")
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
    expect(error).toMatchObject({ status: 503, code: "service_unavailable" })
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
    // The seed has the demo recipient enrolled already.
    expect(await caught(api.keys.enroll(ME_WALLET, SIG))).toMatchObject({
      code: "key_already_enrolled",
    })
    resetAccountStatus()
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
    sender: mockTokenAccount(COMPANY_WALLET),
    aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    wallet_signature: SIG,
    payments: ids.map((id) => ({
      recipient: mockTokenAccount(id),
      amount: "1000000000",
    })),
  })

  it("confirms each position in order, and the run reads completed", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(
      request([bruno.id, diego.id, seedPeople[3].id]),
    )
    for (const payment of run.payments) {
      if (!isSignable(payment)) throw new Error("expected a transaction")
      const after = await api.runs.confirm(run.run_id, {
        payments: [
          {
            position: payment.position,
            request_id: payment.request_id,
            signature: sigOf(payment.position),
          },
        ],
      })
      expect(after.payments[payment.position].status).toBe("finalized")
    }
    const status = await api.runs.get(run.run_id)
    expect(status.status).toBe("completed")
    // The status has no amount anywhere.
    expect(JSON.stringify(status)).not.toMatch(/amount/)
  })

  it("prepares nothing for someone without an account, and the rest as usual", async () => {
    const run = await api.runs.create(request([bruno.id, mariana.id]))
    expect(run.payments.map((p) => p.status)).toEqual([
      "prepared",
      "preparation_failed",
    ])
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
    expect(text.split("\r\n")[0]).toBe(
      "date,counterparty,amount,status,signature",
    )
    expect(text).toContain("Bruno Costa,4200.000000,confirmed")
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

  // The real service answers `unavailable` when it cannot reach the Solana RPC.
  it("reports an unreachable RPC from /health as data, not an error", async () => {
    scenarios.set("rpc-down")
    expect(await signedOut.health()).toMatchObject({
      status: "unavailable",
      rpc_reachable: false,
    })
  })

  it("fails /health like every other route when the service is down", async () => {
    scenarios.set("service-down")
    expect(await caught(signedOut.health())).toMatchObject({
      status: 503,
      code: "service_unavailable",
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

describe("auditors", () => {
  const ANA = "ana.ribeiro@northwind-audit.example"
  const PAULO = "paulo.lima@northwind-audit.example"
  const RITA = "rita.alves@northwind-audit.example"
  const ids = {
    ana: "d0000000-0000-4000-8000-000000000001",
    paulo: "d0000000-0000-4000-8000-000000000002",
    rita: "d0000000-0000-4000-8000-000000000003",
  }
  const listed = async () => (await api.company.auditors.list()).items

  it("lists the three seeded auditors, newest invite first, without an amount", async () => {
    const page = await api.company.auditors.list()
    expect(page.next_cursor).toBeNull()
    expect(page.items.map((a) => a.status)).toEqual([
      "invited",
      "invite-expired",
      "active",
    ])
    expect(page.items.map((a) => a.id)).toEqual([ids.paulo, ids.rita, ids.ana])
    expectNoAmount(page)
  })

  it("derives the status from the age of a pending invite", async () => {
    const paulo = db.auditors.find((a) => a.id === ids.paulo)!
    const week = 7 * 86_400_000
    paulo.invitedAt = new Date(Date.now() - week + 60_000).toISOString()
    expect((await listed()).find((a) => a.id === ids.paulo)?.status).toBe(
      "invited",
    )
    paulo.invitedAt = new Date(Date.now() - week - 60_000).toISOString()
    expect((await listed()).find((a) => a.id === ids.paulo)?.status).toBe(
      "invite-expired",
    )
    // An accepted auditor does not lapse, however old the invite.
    paulo.accepted = true
    expect((await listed()).find((a) => a.id === ids.paulo)?.status).toBe(
      "active",
    )
  })

  it("invites an address, returns the new item and lists it first", async () => {
    const item = await api.company.auditors.invite("carla@audit.example")
    expect(item).toMatchObject({
      email: "carla@audit.example",
      status: "invited",
    })
    expect(Date.now() - Date.parse(item.invited_at)).toBeLessThan(5_000)
    const items = await listed()
    expect(items).toHaveLength(4)
    expect(items[0]).toEqual(item)
    expect(new Set(items.map((a) => a.id)).size).toBe(4)
    expectNoAmount(item)
  })

  it("refuses a second invite to a pending address with auditor_already_invited", async () => {
    await api.company.auditors.invite("carla@audit.example")
    const before = await listed()
    // The address just invited, the seeded pending one, and another case.
    for (const email of ["carla@audit.example", PAULO, "CARLA@audit.example"]) {
      expect(await caught(api.company.auditors.invite(email))).toMatchObject({
        status: 409,
        code: "auditor_already_invited",
      })
    }
    expect(await listed()).toEqual(before)
  })

  it("refuses an address that already audits the company with auditor_already_active", async () => {
    for (const email of [ANA, "Ana.Ribeiro@Northwind-Audit.example"]) {
      expect(await caught(api.company.auditors.invite(email))).toMatchObject({
        status: 409,
        code: "auditor_already_active",
      })
    }
    expect(await listed()).toHaveLength(3)
  })

  it("replaces the seeded expired invite with a fresh one instead of refusing", async () => {
    expect((await listed())[1]).toMatchObject({
      id: ids.rita,
      status: "invite-expired",
    })
    const fresh = await api.company.auditors.invite(RITA)
    expect(fresh.status).toBe("invited")
    expect(fresh.id).not.toBe(ids.rita)
    const items = await listed()
    expect(items).toHaveLength(3)
    expect(items.some((a) => a.id === ids.rita)).toBe(false)
    // The new one is pending, so the address is taken again.
    expect(await caught(api.company.auditors.invite(RITA))).toMatchObject({
      status: 409,
      code: "auditor_already_invited",
    })
  })

  it("sends nothing for a bad address, and allows exactly 320 characters", async () => {
    const bad = [
      "",
      "plain",
      "no@at@all",
      "@x.example",
      "a@",
      "a b@x.example",
      "a@x .example",
      "a@x.example\n",
      `${"a".repeat(316)}@b.co`,
    ]
    for (const email of bad) {
      expect(
        await caught(api.company.auditors.invite(email)),
        JSON.stringify(email),
      ).toBeInstanceOf(ZodError)
    }
    expect(requests).toEqual([])
    const edge = `${"a".repeat(315)}@b.co`
    expect(edge).toHaveLength(320)
    expect((await api.company.auditors.invite(edge)).email).toBe(edge)
    expect(requests).toEqual(["POST /company/auditors"])
  })

  it("revokes an invite, an expired invite and an auditor, and a repeat is a 404", async () => {
    expect(await api.company.auditors.revoke(ids.paulo)).toEqual({
      status: "revoked",
    })
    expect((await listed()).map((a) => a.id)).toEqual([ids.rita, ids.ana])
    expect(await caught(api.company.auditors.revoke(ids.paulo))).toMatchObject({
      status: 404,
      code: "auditor_not_found",
    })
    await api.company.auditors.revoke(ids.rita)
    await api.company.auditors.revoke(ids.ana)
    expect(await listed()).toEqual([])
    expect(requests.filter((r) => r.includes("/revoke"))).toEqual([
      `POST /company/auditors/${ids.paulo}/revoke`,
      `POST /company/auditors/${ids.paulo}/revoke`,
      `POST /company/auditors/${ids.rita}/revoke`,
      `POST /company/auditors/${ids.ana}/revoke`,
    ])
    // A revoked address can be invited again.
    expect((await api.company.auditors.invite(ANA)).status).toBe("invited")
  })

  it("answers 404 for an id that is not an auditor of this company", async () => {
    expect(
      await caught(api.company.auditors.revoke(crypto.randomUUID())),
    ).toMatchObject({ status: 404, code: "auditor_not_found" })
    // An id from another table is no more an auditor than a random one.
    expect(
      await caught(api.company.auditors.revoke(seedPeople[0].id)),
    ).toMatchObject({ status: 404, code: "auditor_not_found" })
    expect(db.auditors).toHaveLength(3)
  })

  it("is for admins only, on all three routes", async () => {
    for (const role of ["recipient", "auditor"] as const) {
      db.role = role
      const calls = [
        () => api.company.auditors.list(),
        () => api.company.auditors.invite("carla@audit.example"),
        () => api.company.auditors.revoke(ids.ana),
      ]
      for (const call of calls) {
        expect(await caught(call())).toMatchObject({
          status: 403,
          code: "forbidden_role",
        })
      }
    }
    // Nothing was added or removed by the refused calls.
    expect(db.auditors.map((a) => a.id)).toEqual([ids.ana, ids.paulo, ids.rita])
    db.role = "admin"
    expect(await listed()).toHaveLength(3)
  })

  it("answers a call with no role chosen, as the mock only enforces one once set", async () => {
    expect(db.role).toBeNull()
    expect(await listed()).toHaveLength(3)
    const item = await api.company.auditors.invite("carla@audit.example")
    expect(await api.company.auditors.revoke(item.id)).toEqual({
      status: "revoked",
    })
  })

  it("fails the usual ways before touching the list", async () => {
    const calls = [
      () => api.company.auditors.list(),
      () => api.company.auditors.invite("carla@audit.example"),
      () => api.company.auditors.revoke(ids.ana),
    ]
    for (const [scenario, expected] of [
      ["unauthenticated", { status: 401, code: "authentication_required" }],
      [
        "rate-limited",
        {
          status: 429,
          code: "rate_limited",
          retryAfter: 60,
          isRetryable: true,
        },
      ],
      [
        "service-down",
        { status: 503, code: "service_unavailable", isRetryable: true },
      ],
    ] as const) {
      scenarios.set(scenario)
      for (const call of calls) {
        expect(await caught(call()), scenario).toMatchObject(expected)
      }
    }
    expect(db.auditors).toHaveLength(3)
    expect(requests).toHaveLength(9)
    // Signed out, the client does not even ask.
    requests.length = 0
    scenarios.clear()
    for (const call of [
      () => signedOut.company.auditors.list(),
      () => signedOut.company.auditors.invite("carla@audit.example"),
      () => signedOut.company.auditors.revoke(ids.ana),
    ]) {
      expect(await caught(call())).toMatchObject({ status: 401 })
    }
    expect(requests).toEqual([])
  })

  it("pages beyond the seeded rows, newest first, with no gap or repeat", async () => {
    for (let i = 0; i < 7; i++) {
      await api.company.auditors.invite(`extra${i}@audit.example`)
    }
    const all = (await api.company.auditors.list({ limit: 100 })).items
    expect(all).toHaveLength(10)
    const seen: string[] = []
    const sizes: number[] = []
    const cursors: (string | null)[] = []
    let cursor: string | undefined
    do {
      const page = await api.company.auditors.list({ limit: 4, cursor })
      sizes.push(page.items.length)
      cursors.push(page.next_cursor)
      seen.push(...page.items.map((a) => a.id))
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    expect(sizes).toEqual([4, 4, 2])
    expect(cursors).toEqual(["4", "8", null])
    expect(seen).toEqual(all.map((a) => a.id))
    expect(new Set(seen).size).toBe(10)
    const times = all.map((a) => Date.parse(a.invited_at))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    // The seeded rows come last, as the oldest invites.
    expect(all.slice(-3).map((a) => a.id)).toEqual([
      ids.paulo,
      ids.rita,
      ids.ana,
    ])
  })
})

describe("access log", () => {
  it("is for auditors only", async () => {
    db.role = "auditor"
    expect((await api.audit.accessLog()).items.length).toBeGreaterThan(0)
    for (const role of ["admin", "recipient"] as const) {
      db.role = role
      expect(await caught(api.audit.accessLog())).toMatchObject({
        status: 403,
        code: "forbidden_role",
      })
    }
  })

  it("answers with no role chosen, as the mock only enforces one once set", async () => {
    expect(db.role).toBeNull()
    expect((await api.audit.accessLog()).items).toHaveLength(25)
  })

  it("fails the usual ways", async () => {
    for (const [scenario, expected] of [
      ["unauthenticated", { status: 401, code: "authentication_required" }],
      [
        "rate-limited",
        {
          status: 429,
          code: "rate_limited",
          retryAfter: 60,
          isRetryable: true,
        },
      ],
      [
        "service-down",
        { status: 503, code: "service_unavailable", isRetryable: true },
      ],
    ] as const) {
      scenarios.set(scenario)
      expect(await caught(api.audit.accessLog()), scenario).toMatchObject(
        expected,
      )
    }
    scenarios.clear()
    expect(await caught(signedOut.audit.accessLog())).toMatchObject({
      status: 401,
    })
    expect(requests).toHaveLength(3)
  })

  it("holds twenty-five rows, newest first, with who and what but no amount", async () => {
    const page = await api.audit.accessLog({ limit: 100 })
    const { items } = page
    expect(items).toHaveLength(25)
    const times = items.map((i) => i.at)
    expect(times).toEqual([...times].sort().reverse())
    expect(new Set(times).size).toBe(25)
    expect(new Set(items.map((i) => i.id)).size).toBe(25)
    // Every actor kind and action is exercised by the seed.
    expect(new Set(items.map((i) => i.actor.kind))).toEqual(
      new Set(accessActorKinds),
    )
    expect(new Set(items.map((i) => i.action))).toEqual(new Set(accessActions))
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "action",
        "actor",
        "at",
        "id",
        "scope",
      ])
      // A scope is words: no figure, so no amount and no payment id.
      expect(item.scope).not.toMatch(/\d/)
    }
    expectNoAmount(page)
  })

  it("pages with the same cursor rules as the other reads", async () => {
    const seen: string[] = []
    const sizes: number[] = []
    let cursor: string | undefined
    do {
      const page = await api.audit.accessLog({ limit: 10, cursor })
      sizes.push(page.items.length)
      seen.push(...page.items.map((i) => i.id))
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    expect(sizes).toEqual([10, 10, 5])
    expect(new Set(seen).size).toBe(25)
    const all = await api.audit.accessLog({ limit: 100 })
    expect(seen).toEqual(all.items.map((i) => i.id))
  })

  it("leaves no next page on an exact fit, and is empty past the end", async () => {
    const exact = await api.audit.accessLog({ limit: 25 })
    expect(exact.items).toHaveLength(25)
    expect(exact.next_cursor).toBeNull()
    const almost = await api.audit.accessLog({ limit: 24 })
    expect(almost.next_cursor).toBe("24")
    expect((await api.audit.accessLog({ cursor: "24" })).items).toHaveLength(1)
    expect(await api.audit.accessLog({ cursor: "25" })).toEqual({
      items: [],
      next_cursor: null,
    })
  })
})

describe("account status", () => {
  const none = {
    wallet_linked: false,
    key_enrolled: false,
    account_configured: false,
    pending_credits: false,
  }

  async function configured(wallet: string) {
    const prepared = await api.accounts.configure(wallet)
    await api.accounts.confirmConfigure({
      request_id: prepared.request_id,
      signature: SIG,
    })
  }

  // The seed is an activated recipient: these tests walk the steps from the start.
  beforeEach(() => resetAccountStatus())

  it("seeds an activated recipient, and resetAccountStatus undoes every step", async () => {
    resetDb()
    expect(await api.me.status()).toEqual({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: true,
      pending_credits: false,
    })
    resetAccountStatus()
    expect(await api.me.status()).toEqual(none)
  })

  it("follows enrollment, configuration and credits, one step at a time", async () => {
    scenarios.set("instant")
    await api.keys.enroll(ME_WALLET, SIG)
    expect(await api.me.status()).toEqual({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: false,
      pending_credits: false,
    })

    // Preparing is not configuring: only the confirmed transaction counts.
    const prepared = await api.accounts.configure(ME_WALLET)
    expect((await api.me.status()).account_configured).toBe(false)
    await api.accounts.confirmConfigure({
      request_id: prepared.request_id,
      signature: SIG,
    })
    expect(await api.me.status()).toMatchObject({
      key_enrolled: true,
      account_configured: true,
      pending_credits: false,
    })

    db.me.pending = 3_000_000n
    expect((await api.me.status()).pending_credits).toBe(true)
    const apply = await api.accounts.applyPending(ME_WALLET)
    await api.accounts.confirmApplyPending({
      request_id: apply.request_id,
      signature: SIG,
    })
    expect((await api.me.status()).pending_credits).toBe(false)
  })

  it("does not let the company's wallet change the recipient's status", async () => {
    scenarios.set("instant")
    await api.keys.enroll(COMPANY_WALLET, SIG)
    await configured(COMPANY_WALLET)
    expect(await api.me.status()).toEqual(none)
    // And the company enrolling did not use up the recipient's enrollment.
    await api.keys.enroll(ME_WALLET, SIG)
    expect(await api.me.status()).toMatchObject({
      wallet_linked: true,
      key_enrolled: true,
    })
  })

  it("links the wallet when its account is configured, with no key enrolled", async () => {
    scenarios.set("instant")
    await configured(ME_WALLET)
    expect(await api.me.status()).toEqual({
      wallet_linked: true,
      key_enrolled: false,
      account_configured: true,
      pending_credits: false,
    })
  })

  it("does not call a configure done while the network is still confirming it", async () => {
    const prepared = await api.accounts.configure(ME_WALLET)
    expect(
      await caught(
        api.accounts.confirmConfigure({
          request_id: prepared.request_id,
          signature: SIG,
        }),
      ),
    ).toMatchObject({ code: "transaction_not_finalized" })
    expect(await api.me.status()).toEqual(none)
  })

  it("keeps a refused second enrollment from changing anything", async () => {
    await api.keys.enroll(ME_WALLET, SIG)
    expect(await caught(api.keys.enroll(ME_WALLET, SIG))).toMatchObject({
      code: "key_already_enrolled",
    })
    expect(await api.me.status()).toMatchObject({
      wallet_linked: true,
      key_enrolled: true,
    })
  })

  it("reports credits that a confirmed run payment left pending", async () => {
    scenarios.set("instant")
    const run = await api.runs.create({
      company_wallet: COMPANY_WALLET,
      sender: mockTokenAccount(COMPANY_WALLET),
      aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
      wallet_signature: SIG,
      payments: [
        { recipient: mockTokenAccount(seedPeople[0].id), amount: "1000000000" },
      ],
    })
    expect((await api.me.status()).pending_credits).toBe(false)
    await api.runs.confirm(run.run_id, {
      payments: [
        {
          position: 0,
          request_id: run.payments[0].request_id ?? "",
          signature: SIG,
        },
      ],
    })
    expect((await api.me.status()).pending_credits).toBe(true)
  })

  it("resets the steps and nothing else: balances and credits stay", async () => {
    await api.keys.enroll(ME_WALLET, SIG)
    db.accountConfigured = true
    db.me.pending = 1n
    db.me.available = 5n
    resetAccountStatus()
    expect(await api.me.status()).toEqual({ ...none, pending_credits: true })
    expect(db.me).toEqual({ available: 5n, pending: 1n })
    // The wallet can enroll again.
    await api.keys.enroll(ME_WALLET, SIG)
  })

  it("counts a configure that was in flight when the status was reset", async () => {
    scenarios.set("instant")
    await api.keys.enroll(ME_WALLET, SIG)
    const prepared = await api.accounts.configure(ME_WALLET)
    resetAccountStatus()
    expect(await api.me.status()).toEqual(none)
    await api.accounts.confirmConfigure({
      request_id: prepared.request_id,
      signature: SIG,
    })
    expect(await api.me.status()).toEqual({
      wallet_linked: true,
      key_enrolled: false,
      account_configured: true,
      pending_credits: false,
    })
  })

  it("is for recipients only", async () => {
    for (const role of ["admin", "auditor"] as const) {
      db.role = role
      expect(await caught(api.me.status())).toMatchObject({
        status: 403,
        code: "forbidden_role",
      })
    }
    db.role = "recipient"
    expect((await api.me.status()).wallet_linked).toBe(false)
  })

  it("answers with no role chosen, as the mock only enforces one once set", async () => {
    expect(db.role).toBeNull()
    expect(await api.me.status()).toEqual(none)
  })

  it("fails the usual ways, and carries no amount", async () => {
    expectNoAmount(await api.me.status())
    for (const [scenario, expected] of [
      ["unauthenticated", { status: 401, code: "authentication_required" }],
      [
        "rate-limited",
        {
          status: 429,
          code: "rate_limited",
          retryAfter: 60,
          isRetryable: true,
        },
      ],
      [
        "service-down",
        { status: 503, code: "service_unavailable", isRetryable: true },
      ],
    ] as const) {
      scenarios.set(scenario)
      expect(await caught(api.me.status()), scenario).toMatchObject(expected)
    }
    scenarios.clear()
    requests.length = 0
    expect(await caught(signedOut.me.status())).toMatchObject({ status: 401 })
    expect(requests).toEqual([])
  })
})
