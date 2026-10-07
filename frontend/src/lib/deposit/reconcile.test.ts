import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt } from "@/lib/api/schemas"
import type { Submission } from "@/lib/submissions"
import { reconcileWrap } from "./reconcile"

const SIG = "5SigMockSignature1111111111111111111111111111"
const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: SIG,
  slot: 1,
  status: "finalized",
}
const record: Submission = {
  kind: "wrap",
  request_id: "a".repeat(64),
  signature: SIG,
  last_valid_block_height: 100,
  wallet: "w",
  at: 1_000,
}

// A chain that only moves when the code sleeps: a block every 400 ms, starting 50 blocks
// before the last valid one (20 s of life left).
function chain(start = record.last_valid_block_height - 50) {
  let elapsed = 0
  const height = () => start + Math.floor(elapsed / 400)
  return {
    height,
    blockHeight: vi.fn(async () => height()),
    sleep: vi.fn(async (ms: number) => {
      elapsed += ms
    }),
  }
}

function setup(answers: (ApiError | Receipt)[], submission = record) {
  const queue = [...answers]
  const confirm = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof ApiError) throw next
    return next
  })
  const { height, blockHeight, sleep } = chain()
  return {
    confirm,
    sleep,
    height,
    blockHeight,
    run: () =>
      reconcileWrap({
        record: submission,
        api: { wrap: { confirm } } as never,
        blockHeight,
        sleep,
      }),
  }
}

const notFinalized = () => new ApiError(409, "transaction_not_finalized")

describe("reconcileWrap", () => {
  it("is confirmed when the service confirms the recorded signature", async () => {
    const { confirm, run } = setup([receipt])
    await expect(run()).resolves.toBe("confirmed")
    expect(confirm).toHaveBeenCalledWith(
      { request_id: record.request_id, signature: SIG },
      expect.anything(),
    )
  })

  it("keeps asking while the network has not finalized it, then confirms", async () => {
    const { confirm, sleep, run } = setup([
      notFinalized(),
      notFinalized(),
      receipt,
    ])
    await expect(run()).resolves.toBe("confirmed")
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("is failed when the network says the transaction failed", async () => {
    const { sleep, run } = setup([new ApiError(409, "transaction_failed")])
    await expect(run()).resolves.toBe("failed")
    expect(sleep).not.toHaveBeenCalled()
  })

  it("is failed once the finalized height is past its last valid block and the service still says it is not there", async () => {
    const { confirm, height, run } = setup([notFinalized()])
    await expect(run()).resolves.toBe("failed")
    expect(height()).toBeGreaterThan(record.last_valid_block_height)
    // Asked again after the height was seen past, not only before.
    expect(confirm.mock.calls.length).toBeGreaterThan(5)
  })

  it("does not call it expired while the finalized height is still at its last valid block", async () => {
    const { height, blockHeight, sleep } = chain()
    const confirm = vi.fn(async () => {
      // Lands in its last valid block, and is finalized a little after.
      if (height() <= record.last_valid_block_height + 1) throw notFinalized()
      return receipt
    })
    blockHeight.mockImplementation(async () =>
      // The finalized height trails: it reaches the last valid block only late.
      Math.min(height(), record.last_valid_block_height),
    )
    const result = await reconcileWrap({
      record,
      api: { wrap: { confirm } } as never,
      blockHeight,
      sleep,
    })
    expect(result).toBe("confirmed")
  })

  it("only counts a 'not there' that came after the height was seen past", async () => {
    // Past already when it is read, but the first answer was asked before that read
    // could have seen it: the order is read, then ask.
    const order: string[] = []
    const confirm = vi.fn(async () => {
      order.push("ask")
      throw notFinalized()
    })
    const blockHeight = vi.fn(async () => {
      order.push("height")
      return record.last_valid_block_height + 1
    })
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        blockHeight,
        sleep: async () => {},
      }),
    ).resolves.toBe("failed")
    expect(order).toEqual(["height", "ask"])
  })

  it("never calls it expired while the block height cannot be read", async () => {
    const { confirm, sleep } = setup([notFinalized()])
    let reads = 0
    const blockHeight = vi.fn(async () => {
      if (++reads <= 20) throw new TypeError("Failed to fetch")
      return record.last_valid_block_height + 1
    })
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        blockHeight,
        sleep,
      }),
    ).resolves.toBe("failed")
    // Kept asking for as long as the height was out of reach.
    expect(confirm).toHaveBeenCalledTimes(21)
  })

  it("is unknown, not failed, when the service could never be reached", async () => {
    const { run } = setup([new ApiError(0, "network_error")])
    await expect(run()).resolves.toBe("unknown")
  })

  it("is unknown when the service could not be reached once the blockhash was past", async () => {
    const { blockHeight, sleep } = chain(record.last_valid_block_height + 1)
    const confirm = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "rpc_unavailable"))
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        blockHeight,
        sleep,
      }),
    ).resolves.toBe("unknown")
  })

  it("recovers from a busy service and a dropped connection", async () => {
    const { run } = setup([
      new ApiError(503, "rpc_unavailable"),
      new ApiError(429, "wrap_rate_limited", 60),
      receipt,
    ])
    await expect(run()).resolves.toBe("confirmed")
  })

  it("waits out a rate limit as long as the service asked", async () => {
    const { sleep, run } = setup([
      new ApiError(429, "wrap_rate_limited", 60),
      receipt,
    ])
    await run()
    expect(sleep.mock.calls[0][0]).toBe(60_000)
  })

  it("is unknown when the service has no record of it: a 404 is not a failure", async () => {
    const { run } = setup([new ApiError(404, "wrap_not_found")])
    await expect(run()).resolves.toBe("unknown")
  })

  it("never asks about a wrap with no signature, and is unknown once its blockhash is gone", async () => {
    const { confirm, height, run } = setup([receipt], {
      ...record,
      signature: null,
    })
    await expect(run()).resolves.toBe("unknown")
    expect(confirm).not.toHaveBeenCalled()
    // It waited for that, not for a clock.
    expect(height()).toBeGreaterThan(record.last_valid_block_height)
  })

  it("answers at once for a record that is already past its blockhash and gets confirmed", async () => {
    const { blockHeight, sleep } = chain(record.last_valid_block_height + 1000)
    const confirm = vi.fn(async () => receipt)
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        blockHeight,
        sleep,
      }),
    ).resolves.toBe("confirmed")
    expect(sleep).not.toHaveBeenCalled()
  })

  it("stops with the abort reason when the person leaves", async () => {
    const abort = new AbortController()
    const confirm = vi.fn()
    abort.abort(new Error("left"))
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        signal: abort.signal,
      }),
    ).rejects.toThrow("left")
    expect(confirm).not.toHaveBeenCalled()
  })

  it("stops with the abort reason when the person leaves during the height read", async () => {
    const abort = new AbortController()
    const confirm = vi.fn()
    const blockHeight = vi.fn(async () => {
      abort.abort(new Error("left"))
      throw abort.signal.reason
    })
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        blockHeight,
        signal: abort.signal,
      }),
    ).rejects.toThrow("left")
    expect(confirm).not.toHaveBeenCalled()
  })
})
