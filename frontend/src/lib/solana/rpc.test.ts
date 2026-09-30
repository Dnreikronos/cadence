import { describe, expect, it } from "vitest"
import type { RpcTransport } from "@solana/kit"
import { createSolanaRpcFromTransport, signature } from "@solana/kit"
import { pinTransactionVersion } from "./rpc"

function recordingTransport() {
  const sent: unknown[] = []
  const transport = (async ({ payload }: { payload: unknown }) => {
    sent.push(payload)
    return { jsonrpc: "2.0", id: 1, result: null }
  }) as RpcTransport
  return { sent, transport }
}

const sig = signature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
)

describe("pinTransactionVersion", () => {
  it("asks for v1 transactions when a caller fetches one without saying", async () => {
    const { sent, transport } = recordingTransport()
    await createSolanaRpcFromTransport(pinTransactionVersion(transport))
      .getTransaction(sig)
      .send()
    expect(sent[0]).toMatchObject({
      method: "getTransaction",
      params: [sig, { maxSupportedTransactionVersion: 1 }],
    })
  })
})

describe("pinTransactionVersion over caller config", () => {
  it("overrides a lower version and keeps the rest of the caller's config", async () => {
    const { sent, transport } = recordingTransport()
    await createSolanaRpcFromTransport(pinTransactionVersion(transport))
      .getBlock(1n, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "signatures",
      })
      .send()
    expect(sent[0]).toMatchObject({
      method: "getBlock",
      params: [
        1n,
        { maxSupportedTransactionVersion: 1, transactionDetails: "signatures" },
      ],
    })
  })

  it("leaves calls that never return a transaction alone", async () => {
    const { sent, transport } = recordingTransport()
    await createSolanaRpcFromTransport(pinTransactionVersion(transport))
      .getSlot()
      .send()
    expect(JSON.stringify(sent[0])).not.toContain(
      "maxSupportedTransactionVersion",
    )
  })
})
