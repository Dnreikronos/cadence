import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt } from "@/lib/api/schemas"
import type { Submission } from "@/lib/submissions"
import { EXPIRY_MS, reconcileWrap } from "./reconcile"

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

// A clock that only moves when the code sleeps.
function setup(answers: (ApiError | Receipt)[], submission = record) {
  let t = submission.at
  const queue = [...answers]
  const confirm = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof ApiError) throw next
    return next
  })
  const sleep = vi.fn(async (ms: number) => {
    t += ms
  })
  return {
    confirm,
    sleep,
    run: () =>
      reconcileWrap({
        record: submission,
        api: { wrap: { confirm } } as never,
        now: () => t,
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

  it("is failed once the blockhash has run out and the service kept saying it was not there", async () => {
    const { confirm, run } = setup([notFinalized()])
    await expect(run()).resolves.toBe("failed")
    // Not before 90 s: the chain read lags, so it waits the whole window out.
    expect(confirm.mock.calls.length).toBeGreaterThan(10)
  })

  it("does not call it expired before 90 seconds have passed", async () => {
    let t = record.at
    const confirm = vi.fn(async () => {
      if (t < record.at + EXPIRY_MS - 1) throw notFinalized()
      return receipt
    })
    const result = await reconcileWrap({
      record,
      api: { wrap: { confirm } } as never,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    expect(result).toBe("confirmed")
  })

  it("is unknown, not failed, when the service could never be reached", async () => {
    const { run } = setup([new ApiError(0, "network_error")])
    await expect(run()).resolves.toBe("unknown")
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
    const { confirm, sleep, run } = setup([receipt], {
      ...record,
      signature: null,
    })
    await expect(run()).resolves.toBe("unknown")
    expect(confirm).not.toHaveBeenCalled()
    expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(EXPIRY_MS)
  })

  it("answers at once for a record that is already past the window and gets confirmed", async () => {
    let t = record.at + EXPIRY_MS * 10
    const confirm = vi.fn(async () => receipt)
    await expect(
      reconcileWrap({
        record,
        api: { wrap: { confirm } } as never,
        now: () => t,
        sleep: async () => void (t += 1),
      }),
    ).resolves.toBe("confirmed")
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
})
