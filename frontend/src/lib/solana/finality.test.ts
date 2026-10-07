import { createSolanaRpcFromTransport, type RpcTransport } from "@solana/kit"
import { afterEach, describe, expect, it } from "vitest"
import { mockFinality, recordOnMockChain } from "@/lib/api/mocks/chain"
import { resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { devnetRunPayment } from "./devnet-fixture"
import { fetchFinality } from "./finality"

const SIGNATURE = devnetRunPayment.signature

// A node that answers getSignatureStatuses with `status` for the one signature.
function rpcAnswering(status: unknown) {
  const sent: { method: string; params: unknown[] }[] = []
  const transport = (async ({ payload }: { payload: unknown }) => {
    sent.push(payload as (typeof sent)[number])
    return {
      jsonrpc: "2.0",
      id: (payload as { id: unknown }).id,
      result: { context: { slot: 1 }, value: [status] },
    }
  }) as RpcTransport
  return { rpc: createSolanaRpcFromTransport(transport), sent }
}

afterEach(() => {
  scenarios.clear()
  resetDb()
})

describe("fetchFinality", () => {
  it("asks for the signature with the whole history searched", async () => {
    const { rpc, sent } = rpcAnswering(null)
    await fetchFinality(SIGNATURE, { rpc })
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe("getSignatureStatuses")
    expect(sent[0].params).toEqual([
      [SIGNATURE],
      { searchTransactionHistory: true },
    ])
  })

  it("is finalized only when the network finalized it without an error", async () => {
    const { rpc } = rpcAnswering({
      slot: 507099198,
      confirmations: null,
      err: null,
      confirmationStatus: "finalized",
    })
    expect(await fetchFinality(SIGNATURE, { rpc })).toBe("finalized")
  })

  it("is failed when the network finalized it with an error", async () => {
    const { rpc } = rpcAnswering({
      slot: 507099198,
      confirmations: null,
      err: { InstructionError: [6, { Custom: 1 }] },
      confirmationStatus: "finalized",
    })
    expect(await fetchFinality(SIGNATURE, { rpc })).toBe("failed")
  })

  it.each([
    ["not seen", null],
    [
      "only confirmed",
      { slot: 1, confirmations: 3, err: null, confirmationStatus: "confirmed" },
    ],
    [
      "failed before it is final",
      {
        slot: 1,
        confirmations: 3,
        err: { InstructionError: [0, "InvalidAccountData"] },
        confirmationStatus: "confirmed",
      },
    ],
  ])("is pending when %s", async (_, status) => {
    const { rpc } = rpcAnswering(status)
    expect(await fetchFinality(SIGNATURE, { rpc })).toBe("pending")
  })
})

describe("mockFinality", () => {
  it("reads what the mock network recorded", async () => {
    expect(await mockFinality(SIGNATURE)).toBe("pending")
    recordOnMockChain(SIGNATURE, "finalized")
    expect(await mockFinality(SIGNATURE)).toBe("finalized")
    recordOnMockChain(SIGNATURE, "failed")
    expect(await mockFinality(SIGNATURE)).toBe("failed")
  })

  it("never sees a transaction under chain-unconfirmed", async () => {
    recordOnMockChain(SIGNATURE, "finalized")
    scenarios.set("chain-unconfirmed")
    expect(await mockFinality(SIGNATURE)).toBe("pending")
  })
})
