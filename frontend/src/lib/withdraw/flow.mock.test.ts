import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
vi.mock("@/lib/api/mode", () => ({ apiConfig: { mode: "mock", baseUrl: "" } }))

import { createApiClient } from "@/lib/api/client"
import { mockFinality } from "@/lib/api/mocks/chain"
import { ME_WALLET, db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner } from "@/lib/api/mocks/signer"
import { signAndConfirm } from "@/lib/api/sign"
import { runWithdraw, type WithdrawDeps } from "./flow"
import { prepareUnwrap } from "./prepare"

// The flow against the mock service, so the screen's two prepare calls are checked
// against the answers it will really get, not only against fakes. The keys come from
// the demo seams, as on the screen.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: "http://mock.cadence.test",
  getToken: async () => "test-token",
})

const deps: WithdrawDeps = {
  prepare: (ask) =>
    prepareUnwrap(mockSigner(ME_WALLET), ask, {
      prepare: (request) => api.unwrap.prepare(request),
      userId: async () => "f0000000-0000-4000-8000-000000000001",
    }),
  signAndConfirm: (prepared, confirm, onStep, extra) =>
    signAndConfirm(prepared, {
      ...extra,
      signer: mockSigner(ME_WALLET),
      submit: async () => "TestSignature".padEnd(64, "1"),
      finality: mockFinality,
      confirm,
      onStep,
      sleep: async () => {},
    }),
  confirm: (request) => api.unwrap.confirm(request),
}

const withdraw = (amount: string, acknowledged: boolean) =>
  runWithdraw(deps, { wallet: ME_WALLET, amount, acknowledged })

describe("withdrawing against the mock service", () => {
  it("withdraws an amount that matches nothing without asking", async () => {
    const before = db.me.available
    const outcome = await withdraw("1000000000", false)
    expect(outcome).toMatchObject({ kind: "done", level: "none" })
    expect(db.me.available).toBe(before - 1_000_000_000n)
  })

  it("asks first for an exact match, moves nothing, then withdraws once agreed", async () => {
    const before = db.me.available
    expect(await withdraw("4200000000", false)).toEqual({
      kind: "needs-acknowledgement",
    })
    expect(db.me.available).toBe(before)

    const outcome = await withdraw("4200000000", true)
    expect(outcome).toMatchObject({ kind: "done", level: "exact" })
    expect(db.me.available).toBe(before - 4_200_000_000n)
  })

  it("links a wallet on its first withdrawal and goes on", async () => {
    db.linkedWallets.clear()
    const outcome = await withdraw("1000000000", false)
    expect(outcome).toMatchObject({ kind: "done", level: "none" })
    expect(db.linkedWallets.has(ME_WALLET)).toBe(true)
  })

  it("reports a close match as such", async () => {
    expect(await withdraw("4190000000", true)).toMatchObject({
      kind: "done",
      level: "near",
    })
  })

  it("fails with the insufficient-balance code when asking for more than is available", async () => {
    await expect(withdraw("9000000000", false)).rejects.toMatchObject({
      status: 409,
      code: "invalid_confidential_state",
    })
  })

  it("surfaces a transaction the network rejects, leaving the balance alone", async () => {
    scenarios.set("tx-failed")
    const before = db.me.available
    await expect(withdraw("1000000000", false)).rejects.toMatchObject({
      code: "transaction_failed",
    })
    expect(db.me.available).toBe(before)
  })
})
