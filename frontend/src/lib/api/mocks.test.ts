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
import { expectNoAmount } from "./no-amount"
import {
  COMPANY_ID,
  COMPANY_WALLET,
  ME_WALLET,
  db,
  resetDb,
  seedPeople,
} from "./mocks/db"
import { handlers } from "./mocks/handlers"
import { mockBlockHeight, mockTokenAccount } from "./mocks/chain"
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

const AES_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="
const runOf = (ids: string[], amount = "1000000000") => ({
  company_wallet: COMPANY_WALLET,
  sender: mockTokenAccount(COMPANY_WALLET),
  aes_key: AES_KEY,
  // The first run of the wallet links it.
  wallet_signature: SIG,
  payments: ids.map((id) => ({ recipient: mockTokenAccount(id), amount })),
})

// Confirms one position of a run with the attempt it was given.
const confirmAt = (run: s.Run, position: number, signature: string) =>
  api.runs.confirm(run.run_id, {
    payments: [
      {
        position,
        request_id: run.payments[position].request_id ?? "",
        signature,
      },
    ],
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
      ...runOf([bruno.id]),
      payments: [{ recipient: COMPANY_WALLET, amount: "1.5" }],
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
      ...runOf([bruno.id]),
      payments: [{ recipient: "not base58!", amount: "1" }],
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

  it("records a run payment once, repeats it for the same signature, and refuses another", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(runOf([bruno.id]))
    const first = await confirmAt(run, 0, SIG)
    expect(first.payments[0]).toMatchObject({
      status: "finalized",
      signature: SIG,
    })
    const second = await confirmAt(run, 0, SIG)
    expect(second.payments[0]).toEqual(first.payments[0])
    expect(second.errors).toBeUndefined()

    const conflict = await confirmAt(run, 0, OTHER_SIG)
    expect(conflict.errors).toEqual([
      { position: 0, error: "payment_already_resolved" },
    ])
    // Paid once.
    expect(db.company.available).toBe(83_000_000_000n)
    expect(db.payments.filter((p) => p.runId === run.run_id)).toHaveLength(1)
  })
})

describe("runs", () => {
  it("refuses the first run of a wallet until it is linked, then remembers the link", async () => {
    db.linkedWallets.clear()
    const unlinked = { ...runOf([bruno.id]), wallet_signature: undefined }
    expect(await caught(api.runs.create(unlinked))).toMatchObject({
      status: 409,
      code: "wallet_link_required",
    })
    await api.runs.create(runOf([bruno.id]))
    expect((await api.runs.create(unlinked)).payments).toHaveLength(1)
  })

  it("refuses a sender the wallet does not own, and duplicate or self payments", async () => {
    const run = runOf([bruno.id, diego.id])
    expect(
      await caught(api.runs.create({ ...run, sender: ME_WALLET })),
    ).toMatchObject({ status: 403, code: "wallet_access_denied" })
    const twice = await post("/runs", {
      ...run,
      payments: [run.payments[0], run.payments[0]],
    })
    expect(await code(twice)).toBe("invalid_payments")
    const self = await post("/runs", {
      ...run,
      payments: [{ recipient: run.sender, amount: "1" }],
    })
    expect(await code(self)).toBe("invalid_payments")
  })

  it("prepares each position in order, with its transaction, and no person or amount", async () => {
    const run = await api.runs.create(runOf([bruno.id, diego.id]))
    expect(run.required_signers).toEqual([COMPANY_WALLET])
    expect(run.payments.map((p) => [p.position, p.destination])).toEqual([
      [0, mockTokenAccount(bruno.id)],
      [1, mockTokenAccount(diego.id)],
    ])
    for (const payment of run.payments) {
      expect(s.isSignable(payment)).toBe(true)
      expect(payment.last_valid_block_height).toBeGreaterThan(mockBlockHeight())
    }
    for (const payment of run.payments) {
      expect(
        Object.keys(payment).filter((key) => /amount|person/.test(key)),
      ).toEqual([])
    }
    // A read carries no transaction.
    const read = await api.runs.get(run.run_id)
    expect(read.payments.some((p) => p.transaction !== undefined)).toBe(false)
  })

  it("answers an account that belongs to no one with preparation_failed and no transaction", async () => {
    const run = await api.runs.create({
      ...runOf([bruno.id]),
      payments: [{ recipient: ME_WALLET, amount: "1" }],
    })
    expect(run.payments[0]).toMatchObject({
      status: "preparation_failed",
      error: "invalid_confidential_state",
      request_id: null,
    })
    expect(run.status).toBe("partial_failure")
  })

  it("answers not finalized as an item error, never as an HTTP error", async () => {
    const run = await api.runs.create(runOf([bruno.id]))
    const first = await confirmAt(run, 0, SIG)
    expect(first.errors).toEqual([
      { position: 0, error: "transaction_not_finalized" },
    ])
    expect(first.payments[0].status).toBe("prepared")
  })

  it("records a payment the network rejected as failed, with its signature", async () => {
    scenarios.set("tx-failed")
    const run = await api.runs.create(runOf([bruno.id]))
    const after = await confirmAt(run, 0, SIG)
    expect(after.payments[0]).toMatchObject({
      status: "failed",
      error: "transaction_failed",
      signature: SIG,
    })
    expect(after.status).toBe("partial_failure")
    expect(db.company.available).toBe(84_000_000_000n)
  })

  it("answers a confirm of an old attempt with payment_attempt_changed", async () => {
    scenarios.set("instant", "partial-failure")
    const run = await api.runs.create(runOf([bruno.id, diego.id]))
    await confirmAt(run, 0, sigOf(0))
    await confirmAt(run, 1, sigOf(1))
    await api.runs.retry(run.run_id, {
      aes_key: AES_KEY,
      payments: [{ position: 1, amount: "1000000000" }],
    })
    const stale = await confirmAt(run, 1, sigOf(1))
    expect(stale.errors).toEqual([
      { position: 1, error: "payment_attempt_changed" },
    ])
  })
})

describe("retry", () => {
  const live = async () => {
    scenarios.set("instant", "partial-failure")
    const run = await api.runs.create(runOf([bruno.id, diego.id, northwind.id]))
    await confirmAt(run, 0, sigOf(0))
    // Rejected by the network: the run stops here, and position 2 is never sent.
    await confirmAt(run, 1, sigOf(1))
    return run
  }
  const retryBody = (
    payments: { position: number; amount: string; signature?: string }[],
  ) => ({ aes_key: AES_KEY, payments })

  it("refuses while a prepared position is live: left out, without a signature, or not landed", async () => {
    const run = await live()
    const failed = { position: 1, amount: "1000000000" }
    expect(
      await caught(api.runs.retry(run.run_id, retryBody([failed]))),
    ).toMatchObject({ status: 409, code: "outstanding_payments" })
    expect(
      await caught(
        api.runs.retry(
          run.run_id,
          retryBody([failed, { position: 2, amount: "1000000000" }]),
        ),
      ),
    ).toMatchObject({ code: "original_signature_required" })
    expect(
      await caught(
        api.runs.retry(
          run.run_id,
          retryBody([
            failed,
            { position: 2, amount: "1000000000", signature: sigOf(2) },
          ]),
        ),
      ),
    ).toMatchObject({ code: "transaction_not_finalized" })
  })

  it("once the live ones expired, rebuilds the failed position and leaves the expired one unresolved", async () => {
    const run = await live()
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    const after = await api.runs.retry(
      run.run_id,
      retryBody([{ position: 1, amount: "2000000000" }]),
    )
    expect(after.errors).toEqual([
      { position: 2, error: "transaction_history_unavailable" },
    ])
    const [paid, rebuilt, stuck] = after.payments
    expect(paid.status).toBe("finalized")
    expect(rebuilt).toMatchObject({ status: "prepared", attempt: 1 })
    expect(rebuilt.request_id).not.toBe(run.payments[1].request_id)
    expect(s.isSignable(rebuilt)).toBe(true)
    // Its transaction is not handed out again.
    expect(stuck).toMatchObject({ status: "prepared", attempt: 0 })
    expect(stuck.transaction).toBeUndefined()

    const done = await confirmAt(after, 1, sigOf(3))
    expect(done.payments[1].status).toBe("finalized")
    // The amount sent with the retry is the one paid.
    expect(db.company.available).toBe(84_000_000_000n - 3_000_000_000n)
  })

  it("rebuilds a position that could not be prepared, with no signature", async () => {
    scenarios.set("instant", "prepare-failed")
    const run = await api.runs.create(runOf([bruno.id, diego.id]))
    expect(run.payments[1].status).toBe("preparation_failed")
    await confirmAt(run, 0, sigOf(0))
    const after = await api.runs.retry(
      run.run_id,
      retryBody([{ position: 1, amount: "1000000000" }]),
    )
    expect(after.payments[1]).toMatchObject({ status: "prepared", attempt: 1 })
  })

  it("skips a finalized position, so nothing is paid twice", async () => {
    scenarios.set("instant")
    const run = await api.runs.create(runOf([bruno.id]))
    await confirmAt(run, 0, SIG)
    const after = await api.runs.retry(
      run.run_id,
      retryBody([{ position: 0, amount: "1000000000" }]),
    )
    expect(after.payments[0]).toMatchObject({ status: "finalized", attempt: 0 })
    expect(db.payments.filter((p) => p.runId === run.run_id)).toHaveLength(1)
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
    for (const position of [0, 1]) {
      await confirmAt(run, position, sigOf(position))
    }
    expect(await api.company.balance()).toMatchObject({
      available: "84500000000",
    })
    // Bruno is the signed-in recipient: his payment is pending for him.
    expect(db.me.pending).toBe(1_000_000_000n)
  })

  it("fails a run payment that would take the company below zero", async () => {
    scenarios.set("instant")
    db.company.available = 500_000_000n
    const run = await api.runs.create(runOf([bruno.id]))
    const after = await confirmAt(run, 0, SIG)
    expect(after.payments[0]).toMatchObject({
      status: "failed",
      error: "transaction_failed",
    })
    expect(db.company.available).toBe(500_000_000n)
    expect(db.me.pending).toBe(0n)
    expect(db.payments.some((p) => p.runId === run.run_id)).toBe(false)
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

describe("auditors over HTTP", () => {
  const invite = (body: unknown) => post("/company/auditors", body)

  it("answers a bad invite body with invalid_request and adds nothing", async () => {
    const bodies = [
      {},
      { email: "plain" },
      { email: "a@b.co", extra: true },
      { email: 5 },
      { email: `${"a".repeat(316)}@b.co` },
      { email: "a b@c.d" },
      [],
      "a@b.co",
    ]
    for (const body of bodies) {
      const response = await invite(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await code(response)).toBe("invalid_request")
    }
    const notJson = await fetch(MOCK_ORIGIN + "/company/auditors", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
      },
      body: "{nope",
    })
    expect(notJson.status).toBe(400)
    expect(await code(notJson)).toBe("invalid_request")
    expect(db.auditors).toHaveLength(3)
  })

  it("answers a created invite with 201 and exactly the item's fields", async () => {
    const response = await invite({ email: "carla@audit.example" })
    expect(response.status).toBe(201)
    const item = await response.json()
    expect(Object.keys(item).sort()).toEqual([
      "email",
      "id",
      "invited_at",
      "status",
    ])
    expect(item).toMatchObject({
      email: "carla@audit.example",
      status: "invited",
    })
  })

  it("answers the two conflicts with their own codes and a 409", async () => {
    const invited = await invite({
      email: "paulo.lima@northwind-audit.example",
    })
    expect(invited.status).toBe(409)
    expect(await invited.json()).toEqual({ error: "auditor_already_invited" })
    const active = await invite({
      email: "ana.ribeiro@northwind-audit.example",
    })
    expect(active.status).toBe(409)
    expect(await active.json()).toEqual({ error: "auditor_already_active" })
  })

  it("revokes with a 200 body of exactly { status: revoked }, and a repeat is a 404 with only a code", async () => {
    const path = "/company/auditors/d0000000-0000-4000-8000-000000000001/revoke"
    const first = await post(path)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ status: "revoked" })
    const again = await post(path)
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: "auditor_not_found" })
    // A value that is not even an id is just as unknown.
    const odd = await post("/company/auditors/not-an-id/revoke")
    expect(odd.status).toBe(404)
    expect(await code(odd)).toBe("auditor_not_found")
    expect(db.auditors.map((a) => a.id)).toEqual([
      "d0000000-0000-4000-8000-000000000002",
      "d0000000-0000-4000-8000-000000000003",
    ])
  })

  it("needs a bearer token, and answers a missing one before it changes anything", async () => {
    const path = "/company/auditors/d0000000-0000-4000-8000-000000000001/revoke"
    for (const [method, route, body] of [
      ["GET", "/company/auditors", undefined],
      ["POST", "/company/auditors", { email: "carla@audit.example" }],
      ["POST", path, undefined],
      ["GET", "/audit/access-log", undefined],
      ["GET", "/me/status", undefined],
    ] as const) {
      const response = await send(method, route, body, false)
      expect(response.status, `${method} ${route}`).toBe(401)
      expect(await response.json()).toEqual({
        error: "authentication_required",
      })
    }
    expect(db.auditors).toHaveLength(3)
  })

  it("keeps amounts out of every new response", async () => {
    const responses = [
      await send("GET", "/company/auditors"),
      await invite({ email: "carla@audit.example" }),
      await invite({ email: "carla@audit.example" }),
      await send("GET", "/audit/access-log?limit=100"),
      await send("GET", "/me/status"),
      await post(
        "/company/auditors/d0000000-0000-4000-8000-000000000002/revoke",
      ),
    ]
    for (const response of responses) {
      expectNoAmount(await response.json())
    }
  })

  it("answers a rate limit on these routes with the generic rate_limited, not a payments code", async () => {
    scenarios.set("rate-limited")
    const path = "/company/auditors/d0000000-0000-4000-8000-000000000001/revoke"
    for (const [method, route, body] of [
      ["GET", "/company/auditors", undefined],
      ["POST", "/company/auditors", { email: "carla@audit.example" }],
      ["POST", path, undefined],
      ["GET", "/audit/access-log", undefined],
      ["GET", "/me/status", undefined],
    ] as const) {
      const response = await send(method, route, body)
      expect(response.status, `${method} ${route}`).toBe(429)
      expect(response.headers.get("retry-after")).toBe("60")
      expect(await response.json()).toEqual({ error: "rate_limited" })
    }
    expect(db.auditors).toHaveLength(3)
  })

  it("does not serve the old DELETE path any more", async () => {
    const response = await send(
      "DELETE",
      "/company/auditors/d0000000-0000-4000-8000-000000000001",
    ).catch(() => undefined)
    // Unhandled: either refused outright or answered with something that is not a revoke.
    if (response) expect(response.status).not.toBe(200)
    expect(db.auditors).toHaveLength(3)
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
      "/company/auditors",
      "/audit/access-log",
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
