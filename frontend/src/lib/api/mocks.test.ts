import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { createApiClient } from "./client"
import { MOCK_ORIGIN } from "./config"
import * as s from "./schemas"
import { signAndConfirm, type Signer } from "./sign"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_WALLET,
  db,
  resetDb,
  seedPeople,
} from "./mocks/db"
import { handlers } from "./mocks/handlers"
import { scenarios } from "./mocks/scenario"
import { server } from "./mocks/server"

// How the mock behaves where it has to match the real service: what it refuses,
// what it answers twice, and what it does to the ledgers.

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  vi.restoreAllMocks()
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})

const SIG = "5SigMockSignature1111111111111111111111111111"
const OTHER_SIG = "4AnotherMockSignature".padEnd(64, "1")
const signer: Signer = {
  address: COMPANY_WALLET,
  signTransaction: async (bytes) => Uint8Array.from([...bytes, 1]),
}
const [bruno, , diego, northwind] = seedPeople

// A request as the browser would send it, without the client's own checks.
const send = (method: string, path: string, body?: unknown, token = true) =>
  fetch(MOCK_ORIGIN + path, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer test-token" } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const post = (path: string, body?: unknown) => send("POST", path, body)

async function code(response: Response) {
  return ((await response.json()) as { error: string }).error
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the call to fail")
}

const runOf = (ids: string[], amount = "1000000000") => ({
  company_wallet: COMPANY_WALLET,
  payments: ids.map((person_id) => ({ person_id, amount })),
  idempotency_key: crypto.randomUUID(),
})

// A signature that is valid base58 and different for each payment.
const sigOf = (n: number) => `TestSignature${"abcdefghij"[n]}`.padEnd(64, "1")

describe("bad requests", () => {
  it("answers invalid_request for a body that is not JSON, and for an unknown key", async () => {
    const notJson = await fetch(MOCK_ORIGIN + "/wrap", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
      },
      body: "{nope",
    })
    expect(notJson.status).toBe(400)
    expect(await code(notJson)).toBe("invalid_request")

    const extra = await post("/wrap", {
      company_wallet: COMPANY_WALLET,
      amount: "1000000",
      extra: true,
    })
    expect(extra.status).toBe(400)
    expect(await code(extra)).toBe("invalid_request")
  })

  it("answers invalid_amount when any issue is on an amount, however deep", async () => {
    const bad = await post("/runs", {
      company_wallet: COMPANY_WALLET,
      payments: [{ person_id: bruno.id, amount: "1.5" }],
      idempotency_key: crypto.randomUUID(),
    })
    expect(await code(bad)).toBe("invalid_amount")

    // A bad wallet as well: the amount still decides the code.
    const both = await post("/unwrap", {
      wallet: "short",
      amount: "abc",
      acknowledge_reveal_risk: false,
    })
    expect(await code(both)).toBe("invalid_amount")

    const notAmount = await post("/runs", {
      company_wallet: COMPANY_WALLET,
      payments: [{ person_id: "not-a-guid", amount: "1" }],
      idempotency_key: crypto.randomUUID(),
    })
    expect(await code(notAmount)).toBe("invalid_request")
  })

  it("answers 400 rather than a 500 when validation itself throws", async () => {
    vi.spyOn(s.wrapRequestSchema, "safeParse").mockImplementation(() => {
      throw new Error("boom at /src/secret/path.ts")
    })
    const response = await post("/wrap", {
      company_wallet: COMPANY_WALLET,
      amount: "1",
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: "invalid_request" })
    expect(text).not.toMatch(/boom|secret|stack/)
  })
})

describe("origin", () => {
  it("only answers on the mock's own origin", async () => {
    expect(handlers.length).toBeGreaterThan(20)
    for (const handler of handlers) {
      expect(handler.info.path).toMatch(
        new RegExp(`^${MOCK_ORIGIN.replaceAll(".", "\\.")}/`),
      )
    }
    // A same-origin Next route with the same path is left alone.
    await expect(
      fetch("http://localhost:3000/me/payments", {
        headers: { authorization: "Bearer t" },
      }),
    ).rejects.toThrow()
    expect((await send("GET", "/me/balance")).status).toBe(200)
  })
})

describe("confirm", () => {
  async function wrapped(amount = "1000000") {
    const prepared = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount,
    })
    return prepared.request_id
  }

  it("names a malformed request id and a malformed signature", async () => {
    scenarios.set("instant")
    for (const request_id of ["abc", "A".repeat(64), "g".repeat(64), ""]) {
      const response = await post("/wrap/confirm", {
        request_id,
        signature: SIG,
      })
      expect(response.status).toBe(400)
      expect(await code(response)).toBe("invalid_request_id")
    }
    const request_id = await wrapped()
    for (const signature of ["sig", "", "0".repeat(60), SIG + "!"]) {
      const response = await post("/wrap/confirm", { request_id, signature })
      expect(response.status).toBe(400)
      expect(await code(response)).toBe("invalid_signature")
    }
    expect(db.company.pending).toBe(0n)
  })

  it("replays the stored receipt for the same signature and conflicts for another", async () => {
    scenarios.set("instant")
    const request_id = await wrapped()
    const first = await api.wrap.confirm({ request_id, signature: SIG })
    expect(await api.wrap.confirm({ request_id, signature: SIG })).toEqual(
      first,
    )
    const conflict = await post("/wrap/confirm", {
      request_id,
      signature: OTHER_SIG,
    })
    expect(conflict.status).toBe(409)
    expect(await code(conflict)).toBe("wrap_already_confirmed")
    expect(db.company.pending).toBe(1_000_000n)
  })

  it("uses transfer_already_confirmed for a transfer and a generic code for the rest", async () => {
    scenarios.set("instant")
    const transfer = await api.transfer.prepare({
      company_wallet: COMPANY_WALLET,
      sender: COMPANY_WALLET,
      recipient: ME_WALLET,
      amount: "1000000",
      aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    })
    await api.transfer.confirm({
      request_id: transfer.request_id,
      signature: SIG,
    })
    const again = await post("/transfer/confirm", {
      request_id: transfer.request_id,
      signature: OTHER_SIG,
    })
    expect(await code(again)).toBe("transfer_already_confirmed")

    const apply = await api.accounts.applyPending(ME_WALLET)
    await api.accounts.confirmApplyPending({
      request_id: apply.request_id,
      signature: SIG,
    })
    const other = await post("/accounts/apply-pending/confirm", {
      request_id: apply.request_id,
      signature: OTHER_SIG,
    })
    expect(other.status).toBe(409)
    expect(await code(other)).toBe("already_confirmed")
  })

  it("uses wrap_rate_limited on the wrap routes and transfer_rate_limited on transfers", async () => {
    scenarios.set("rate-limited")
    const body = { request_id: "a".repeat(64), signature: SIG }
    const wrap = { company_wallet: COMPANY_WALLET, amount: "1" }
    const transfer = {
      company_wallet: COMPANY_WALLET,
      sender: COMPANY_WALLET,
      recipient: ME_WALLET,
      amount: "1",
      aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    }
    expect(await code(await post("/wrap", wrap))).toBe("wrap_rate_limited")
    expect(await code(await post("/wrap/confirm", body))).toBe(
      "wrap_rate_limited",
    )
    expect(await code(await post("/transfer", transfer))).toBe(
      "transfer_rate_limited",
    )
    expect(await code(await post("/transfer/confirm", body))).toBe(
      "transfer_rate_limited",
    )
    const response = await post("/wrap", wrap)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
  })

  it("repeats a run payment's receipt, slot included, and conflicts on another signature", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(runOf([bruno.id]))
    const [payment] = run.payments
    const first = await api.runs.confirmPayment(
      run.run_id,
      payment.payment_id,
      SIG,
    )
    const second = await api.runs.confirmPayment(
      run.run_id,
      payment.payment_id,
      SIG,
    )
    expect(second).toEqual(first)
    expect(second.slot).toBe(first.slot)

    const conflict = await caught(
      api.runs.confirmPayment(run.run_id, payment.payment_id, OTHER_SIG),
    )
    expect(conflict).toMatchObject({
      status: 409,
      code: "transfer_already_confirmed",
    })
    const bad = await post(
      `/runs/${run.run_id}/payments/${payment.payment_id}/confirm`,
      { signature: "sig" },
    )
    expect(await code(bad)).toBe("invalid_signature")
    // Paid once.
    expect(db.company.available).toBe(83_000_000_000n)
    expect(db.payments.filter((p) => p.id === payment.payment_id)).toHaveLength(
      1,
    )
  })
})

describe("retry", () => {
  it("refuses a payment that is pending, signed or confirmed, and credits nothing twice", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(runOf([bruno.id, diego.id]))
    const [first, second] = run.payments
    expect(
      await caught(api.runs.retryPayment(run.run_id, first.payment_id)),
    ).toMatchObject({ status: 409, code: "payment_not_retryable" })

    await api.runs.confirmPayment(run.run_id, first.payment_id, SIG)
    const pending = db.me.pending
    const payments = db.payments.length
    expect(
      await caught(api.runs.retryPayment(run.run_id, first.payment_id)),
    ).toMatchObject({ status: 409, code: "payment_not_retryable" })
    // And a confirm of the old request cannot pay again.
    expect(db.me.pending).toBe(pending)
    expect(db.payments).toHaveLength(payments)

    // Signed: the confirm is under way but not final.
    scenarios.clear()
    await caught(
      api.runs.confirmPayment(run.run_id, second.payment_id, OTHER_SIG),
    )
    const status = await api.runs.get(run.run_id)
    expect(status.payments[1].status).toBe("signed")
    expect(
      await caught(api.runs.retryPayment(run.run_id, second.payment_id)),
    ).toMatchObject({ code: "payment_not_retryable" })
  })

  it("lets a failed payment be retried", async () => {
    scenarios.set("tx-failed")
    const run = await api.runs.create(runOf([bruno.id]))
    const [payment] = run.payments
    await caught(api.runs.confirmPayment(run.run_id, payment.payment_id, SIG))
    expect((await api.runs.get(run.run_id)).payments[0].status).toBe("failed")
    const retry = await api.runs.retryPayment(run.run_id, payment.payment_id)
    expect(retry.request_id).not.toBe(payment.request_id)
  })
})

describe("partial-failure", () => {
  it("fails payments 2 and 3 once, so a retry can succeed end to end", async () => {
    scenarios.set("instant", "partial-failure")
    const run = await api.runs.create(runOf([bruno.id, diego.id, northwind.id]))
    const confirm = (i: number) =>
      api.runs.confirmPayment(run.run_id, run.payments[i].payment_id, sigOf(i))
    const statuses = async () =>
      (await api.runs.get(run.run_id)).payments.map((p) => p.status)

    await confirm(0)
    expect(await caught(confirm(1))).toMatchObject({
      code: "transaction_failed",
    })
    expect(await caught(confirm(2))).toMatchObject({
      code: "transaction_failed",
    })
    expect(await statuses()).toEqual(["confirmed", "failed", "expired"])

    for (const i of [1, 2]) {
      const retry = await api.runs.retryPayment(
        run.run_id,
        run.payments[i].payment_id,
      )
      expect(retry.request_id).not.toBe(run.payments[i].request_id)
      // A new transaction is out, so it is no longer reported as expired.
      expect((await statuses())[i]).toBe("pending")
      await signAndConfirm(retry, {
        signer,
        submit: async () => sigOf(i),
        confirm: (signature) =>
          api.runs.confirmPayment(run.run_id, retry.payment_id, signature),
      })
    }
    expect(await statuses()).toEqual(["confirmed", "confirmed", "confirmed"])
    expect(db.company.available).toBe(84_000_000_000n - 3_000_000_000n)
  })

  it("keeps payment 3 reported as expired until it is retried, even before a confirm", async () => {
    scenarios.set("partial-failure")
    const run = await api.runs.create(runOf([bruno.id, diego.id, northwind.id]))
    const status = await api.runs.get(run.run_id)
    expect(status.payments.map((p) => p.status)).toEqual([
      "pending",
      "pending",
      "expired",
    ])
    await api.runs.retryPayment(run.run_id, run.payments[2].payment_id)
    expect((await api.runs.get(run.run_id)).payments[2].status).toBe("pending")
  })
})

describe("ledgers", () => {
  it("reads the company balance, and only as an admin", async () => {
    expect(await api.company.balance()).toMatchObject({
      available: "84000000000",
      pending: "0",
    })
    db.role = "recipient"
    expect(await caught(api.company.balance())).toMatchObject({
      status: 403,
      code: "forbidden_role",
    })
  })

  it("moves a wrap to pending, apply-pending to available, and a run out of available", async () => {
    scenarios.set("instant")
    const wrap = await api.wrap.prepare({
      company_wallet: COMPANY_WALLET,
      amount: "2500000000",
    })
    await api.wrap.confirm({ request_id: wrap.request_id, signature: SIG })
    expect(await api.company.balance()).toMatchObject({
      available: "84000000000",
      pending: "2500000000",
    })

    const apply = await api.accounts.applyPending(COMPANY_WALLET)
    await api.accounts.confirmApplyPending({
      request_id: apply.request_id,
      signature: OTHER_SIG,
    })
    expect(await api.company.balance()).toMatchObject({
      available: "86500000000",
      pending: "0",
    })
    // The recipient's side is untouched.
    expect(db.me).toEqual({ available: 8_000_000_000n, pending: 0n })

    const run = await api.runs.create(runOf([bruno.id, diego.id]))
    for (const [i, payment] of run.payments.entries()) {
      await api.runs.confirmPayment(run.run_id, payment.payment_id, sigOf(i))
    }
    expect(await api.company.balance()).toMatchObject({
      available: "84500000000",
    })
    // Bruno is the signed-in recipient: his payment is pending for him.
    expect(db.me.pending).toBe(1_000_000_000n)
  })

  it("refuses a run payment that would take the company below zero", async () => {
    scenarios.set("instant")
    db.company.available = 500_000_000n
    const run = await api.runs.create(runOf([bruno.id]))
    const [payment] = run.payments
    expect(
      await caught(
        api.runs.confirmPayment(run.run_id, payment.payment_id, SIG),
      ),
    ).toMatchObject({ status: 409, code: "invalid_confidential_state" })
    expect(db.company.available).toBe(500_000_000n)
    expect(db.me.pending).toBe(0n)
    expect(db.payments.some((p) => p.id === payment.payment_id)).toBe(false)
    expect((await api.runs.get(run.run_id)).payments[0].status).not.toBe(
      "confirmed",
    )
  })

  it("refuses an unwrap confirm that would take the recipient below zero", async () => {
    scenarios.set("instant")
    const prepare = () =>
      api.unwrap.prepare({
        wallet: ME_WALLET,
        amount: "5000000000",
        acknowledge_reveal_risk: false,
      })
    // Both fit the 8,000 balance on their own.
    const first = await prepare()
    const second = await prepare()
    await api.unwrap.confirm({ request_id: first.request_id, signature: SIG })
    expect(db.me.available).toBe(3_000_000_000n)
    expect(
      await caught(
        api.unwrap.confirm({
          request_id: second.request_id,
          signature: OTHER_SIG,
        }),
      ),
    ).toMatchObject({ status: 409, code: "invalid_confidential_state" })
    expect(db.me.available).toBe(3_000_000_000n)
  })
})

describe("CSV", () => {
  async function exported(name: string) {
    const original = diego.name
    diego.name = name
    try {
      return (await (await api.exports.company()).text()).split("\n")
    } finally {
      diego.name = original
    }
  }

  it("quotes commas, quotes and newlines (RFC 4180)", async () => {
    const text = await exported('Diego, "Dee" =HYPERLINK("x")\nMartins')
    // The header is unchanged.
    expect(text[0]).toBe("date,counterparty,amount,status,signature")
    // The cell is one quoted field: quotes doubled, the newline kept inside.
    expect(text.join("\n")).toContain(
      '2026-09-01,"Diego, ""Dee"" =HYPERLINK(""x"")\nMartins",6300,confirmed,',
    )
  })

  it.each([
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTabbed", "'\tTabbed"],
    ["=1,2", `"'=1,2"`],
    ['=A1&"x"', `"'=A1&""x"""`],
    ["Plain Name", "Plain Name"],
    ["Ana-Maria = Silva", "Ana-Maria = Silva"],
  ])("neutralises a formula and quotes %j", async (name, cell) => {
    const lines = await exported(name)
    expect(lines.join("\n")).toContain(`2026-09-01,${cell},6300,confirmed,`)
  })

  it("keeps the CSV one row per payment with five fields on every plain row", async () => {
    const lines = await exported("Plain Name")
    expect(lines).toHaveLength(1 + db.payments.length)
    for (const line of lines) expect(line.split(",")).toHaveLength(5)
  })

  it("exports an auditor's view of the one company they may read", async () => {
    db.role = "auditor"
    const text = await (await api.exports.audit(COMPANY_ID)).text()
    expect(text.split("\n")[0]).toBe(
      "date,counterparty,amount,status,signature",
    )
  })
})

describe("paging", () => {
  it.each([
    "cursor=-1",
    "cursor=abc",
    "cursor=1.5",
    "cursor=1e2",
    "cursor=",
    "limit=0",
    "limit=-5",
    "limit=abc",
    "limit=",
    "limit=2.5",
  ])("refuses ?%s with invalid_request", async (query) => {
    for (const path of [
      "/company/payments",
      "/me/payments",
      "/company/people/amounts",
    ]) {
      const response = await send("GET", `${path}?${query}`)
      expect(response.status).toBe(400)
      expect(await code(response)).toBe("invalid_request")
    }
  })

  it("clamps a limit over 100 and ends the pages past the last row", async () => {
    const all = await api.company.payments({ limit: 1000 })
    expect(all.items).toHaveLength(db.payments.length)
    expect(all.next_cursor).toBeNull()
    const past = await api.company.payments({ cursor: "99" })
    expect(past).toEqual({ items: [], next_cursor: null })
  })

  it("ignores no cursor and no limit", async () => {
    const page = await api.company.payments()
    expect(page.items).toHaveLength(db.payments.length)
  })
})
