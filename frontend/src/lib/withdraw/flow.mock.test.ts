import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createApiClient } from "@/lib/api/client"
import { ME_WALLET, db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner } from "@/lib/api/mocks/signer"
import { signAndConfirm } from "@/lib/api/sign"
import { runWithdraw, type WithdrawDeps } from "./flow"

// The flow against the mock service, so the screen's two prepare calls are checked
// against the answers it will really get, not only against fakes.
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
  prepare: (request) => api.unwrap.prepare(request),
  signAndConfirm: (prepared, confirm, onStep, onSubmitted) =>
    signAndConfirm(prepared, {
      signer: mockSigner(ME_WALLET),
      submit: async () => "TestSignature".padEnd(64, "1"),
      confirm,
      onStep,
      onSubmitted,
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
