import { createSolanaRpcFromTransport } from "@solana/kit"
import type { RpcTransport } from "@solana/kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mockBlockHeight } from "@/lib/api/mocks/chain"

const config = vi.hoisted(() => ({ mode: "mock" as "mock" | "real" }))
vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))

// The real read goes to whatever RPC `createRpc` builds: here, one that answers 777.
const node = vi.hoisted(() => ({ sent: [] as unknown[] }))
vi.mock("./rpc", async () => {
  const { createSolanaRpcFromTransport } = await import("@solana/kit")
  return {
    createRpc: () =>
      createSolanaRpcFromTransport((async ({ payload }) => {
        node.sent.push(payload)
        return { jsonrpc: "2.0", id: 1, result: 777 }
      }) as RpcTransport),
  }
})

import {
  fetchBlockHeight,
  pastBlockhash,
  readBlockHeight,
} from "./block-height"

function rpcAnswering(height: number | bigint) {
  const sent: { method: string; params: unknown[] }[] = []
  const transport = (async ({ payload }: { payload: unknown }) => {
    sent.push(payload as (typeof sent)[number])
    return {
      jsonrpc: "2.0",
      id: (payload as { id: unknown }).id,
      result: height,
    }
  }) as RpcTransport
  return { sent, rpc: createSolanaRpcFromTransport(transport) }
}

// Kit leaves `finalized` out of the request: it is the node's default.
const commitmentOf = (payload: unknown) =>
  (payload as { params: { commitment?: string }[] }).params[0]?.commitment ??
  "finalized"

afterEach(() => {
  config.mode = "mock"
  node.sent.length = 0
  vi.useRealTimers()
})

describe("fetchBlockHeight", () => {
  it("asks the node for the finalized block height", async () => {
    const { sent, rpc } = rpcAnswering(250_000_000)
    await expect(fetchBlockHeight({ rpc })).resolves.toBe(250_000_000)
    expect(sent[0].method).toBe("getBlockHeight")
    expect(commitmentOf(sent[0])).toBe("finalized")
  })
})

describe("readBlockHeight", () => {
  it("reads the mock chain's height from the clock in mock mode", async () => {
    vi.useFakeTimers({ now: 4_000_000 })
    await expect(readBlockHeight()).resolves.toBe(mockBlockHeight())
    vi.advanceTimersByTime(4_000)
    await expect(readBlockHeight()).resolves.toBe(mockBlockHeight(4_004_000))
    expect(node.sent).toEqual([])
  })

  it("goes to the chain, not the clock, in real mode", async () => {
    config.mode = "real"
    await expect(readBlockHeight()).resolves.toBe(777)
    expect(node.sent).toHaveLength(1)
    expect(commitmentOf(node.sent[0])).toBe("finalized")
  })
})

describe("pastBlockhash", () => {
  it("is past only once the finalized height has gone beyond the last valid one", () => {
    expect(pastBlockhash(100, 99)).toBe(false)
    // A transaction can still land in its last valid block.
    expect(pastBlockhash(100, 100)).toBe(false)
    expect(pastBlockhash(100, 101)).toBe(true)
  })
})
