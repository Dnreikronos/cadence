import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt, UnwrapPrepared } from "@/lib/api/schemas"
import { ConfirmTimeoutError, type SignStep } from "@/lib/api/sign"
import { viewerScopeId, type SubmissionStorage } from "@/lib/submissions"
import {
  initialWithdraw,
  runWithdraw,
  withdrawReducer,
  type WithdrawDeps,
} from "./flow"
import {
  checkHeldWithdrawals,
  checkableKey,
  heldCheckMessage,
  heldOf,
  heldRecords,
  heldRecordSchema,
  heldRecordsFor,
  withdrawEvidence,
  type HeldRecord,
} from "./held"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const blocked: SubmissionStorage = {
  getItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("blocked")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
}

const ana = { company: "Solaris", email: "ana@example.com" }
const bruno = { company: "Solaris", email: "bruno@example.com" }
const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const REQUEST = "a".repeat(64)
const SIG = "5SigMockSignature1111111111111111111111111111"
const LAST_VALID = 321
const receipt: Receipt = {
  request_id: REQUEST,
  signature: SIG,
  slot: 1,
  status: "finalized",
}
const prepared: UnwrapPrepared = {
  request_id: REQUEST,
  transaction: "AQID",
  transaction_version: 1,
  required_signers: [wallet],
  recent_blockhash: "hash",
  last_valid_block_height: LAST_VALID,
  reveal_risk: { level: "none", matches: [] },
}
const record = (overrides: Partial<HeldRecord> = {}): HeldRecord => ({
  amount_units: "1000000000",
  request_id: REQUEST,
  signature: SIG,
  last_valid_block_height: LAST_VALID,
  at: 1_000,
  ...overrides,
})

const notFinalized = () => new ApiError(409, "transaction_not_finalized")
const failed = () => new ApiError(409, "transaction_failed")

// A chain that only moves when the code sleeps, a block every 400 ms, so a blockhash's
// minute runs instantly. It starts where the record's blockhash was just read.
function chain(start = LAST_VALID - 150) {
  let time = 0
  const height = () => start + Math.floor(time / 400)
  return {
    height,
    blockHeight: async () => height(),
    sleep: async (ms: number) => void (time += ms),
  }
}

const confirmer = (...answers: (Receipt | ApiError)[]) =>
  vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]
    if (next instanceof ApiError) throw next
    return next
  })

function check(
  records: ReturnType<typeof heldRecords>,
  confirm: WithdrawDeps["confirm"],
  extra: Partial<Parameters<typeof checkHeldWithdrawals>[0]> = {},
) {
  const refresh = vi.fn()
  const { blockHeight, sleep } = chain()
  return {
    refresh,
    done: checkHeldWithdrawals({
      records,
      api: { unwrap: { confirm } },
      refresh,
      blockHeight,
      sleep,
      pollMs: 3_000,
      ...extra,
    }),
  }
}

describe("held records", () => {
  it("keeps one per amount, and a record with a signature replaces one without", () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record({ signature: undefined }))
    records.upsert(record())
    records.upsert(record({ amount_units: "2000000000", signature: undefined }))
    expect(records.read().map((r) => [r.amount_units, r.signature])).toEqual([
      ["1000000000", SIG],
      ["2000000000", undefined],
    ])
  })

  it("is read back after a reload, and turns into the held list the reducer refuses from", () => {
    const storage = fakeStorage()
    heldRecords(ana, storage).upsert(record())
    const reloaded = heldRecords(ana, storage).read()
    expect(heldOf(reloaded)).toEqual([{ amount: "1000000000", signature: SIG }])
    expect(heldOf([record({ signature: undefined })])).toEqual([
      { amount: "1000000000", signature: null },
    ])
  })

  it("holds the amount and no secret", () => {
    const storage = fakeStorage()
    heldRecords(ana, storage).upsert(record())
    const [raw] = [...storage.items.values()]
    expect(JSON.parse(raw)).toEqual([record()])
    expect([...storage.items.keys()][0]).not.toContain("ana")
  })

  it("keeps two viewers apart: neither sees nor clears the other's records", () => {
    const storage = fakeStorage()
    const anas = heldRecords(ana, storage)
    const brunos = heldRecords(bruno, storage)
    anas.upsert(record())
    expect(heldRecords(bruno, storage).read()).toEqual([])
    brunos.upsert(record({ amount_units: "5000000000" }))
    // Bruno's records settle and go; Ana's are untouched.
    brunos.remove(() => true)
    expect(heldRecords(ana, storage).read()).toEqual([record()])
    // A company is part of who someone is.
    expect(heldRecords({ ...ana, company: "Other" }, storage).read()).toEqual(
      [],
    )
  })

  it("hands every screen the same list for a viewer, and another list to the next one", () => {
    const first = heldRecordsFor({ company: "Test Co", email: "one@test.io" })
    expect(heldRecordsFor({ company: "Test Co", email: "one@test.io" })).toBe(
      first,
    )
    const next = heldRecordsFor({ company: "Test Co", email: "two@test.io" })
    expect(next).not.toBe(first)
    first.upsert(record({ amount_units: "42" }))
    // Signing out clears the query cache, not this; signing in as someone else sees none.
    expect(next.read()).toEqual([])
    expect(first.read()).toHaveLength(1)
    first.remove(() => true)
  })

  it("works when storage is unavailable: the amount is still held while the page lives", () => {
    const records = heldRecords(ana, blocked)
    expect(records.read()).toEqual([])
    expect(() => records.upsert(record())).not.toThrow()
    expect(heldOf(records.read())).toHaveLength(1)
    // Nothing survives a reload, as before records were kept.
    expect(heldRecords(ana, blocked).read()).toEqual([])
  })

  it("lists the signatures a check can ask about, and only the ones it will look at", () => {
    expect(
      checkableKey(
        [record(), record({ amount_units: "7", signature: "B" })],
        (r) => r.amount_units === "7",
      ),
    ).toBe("7:B")
    expect(checkableKey([])).toBe("")
    expect(checkableKey([record({ signature: undefined })])).toBe("")
    expect(checkableKey([record({ request_id: undefined })])).toBe("")
    expect(
      checkableKey([record(), record({ amount_units: "7", signature: "B" })]),
    ).toBe(`1000000000:${SIG}|7:B`)
  })
})

describe("what runWithdraw leaves behind", () => {
  // The transaction goes through the steps, then does what `after` says.
  function deps(
    after: (onSubmitted: (signature: string) => void) => Promise<Receipt>,
  ): WithdrawDeps {
    return {
      prepare: vi.fn(async () => prepared),
      signAndConfirm: vi.fn(async (_p, _confirm, onStep, onSubmitted) => {
        for (const step of ["signing", "submitting"] as SignStep[]) {
          onStep(step)
        }
        return after(onSubmitted)
      }),
      confirm: vi.fn(async () => receipt),
    }
  }
  const run = (d: WithdrawDeps, records: ReturnType<typeof heldRecords>) =>
    runWithdraw(d, {
      wallet,
      amount: "1000000000",
      acknowledged: false,
      ...withdrawEvidence(records, "1000000000", () => 5_000),
    })

  it("records it before the submit, with no signature, and again with the signature", async () => {
    const records = heldRecords(ana, fakeStorage())
    const seen: (string | undefined)[] = []
    records.subscribe(() => seen.push(records.read()[0]?.signature))
    await run(
      deps(async (onSubmitted) => {
        expect(records.read()).toEqual([
          {
            amount_units: "1000000000",
            request_id: REQUEST,
            last_valid_block_height: 321,
            at: 5_000,
          },
        ])
        onSubmitted(SIG)
        return receipt
      }),
      records,
    )
    // Written without a signature, then with it, then dropped once it landed.
    expect(seen).toEqual([undefined, SIG, undefined])
    expect(records.read()).toEqual([])
  })

  it("keeps the time it was first sent when the signature is added", async () => {
    const records = heldRecords(ana, fakeStorage())
    let time = 5_000
    const { onSent } = withdrawEvidence(records, "1000000000", () => time)
    onSent({ request_id: REQUEST, last_valid_block_height: 1, signature: null })
    time = 9_000
    onSent({ request_id: REQUEST, last_valid_block_height: 1, signature: SIG })
    expect(records.read()).toEqual([
      expect.objectContaining({ signature: SIG, at: 5_000 }),
    ])
  })

  it("keeps the record when the confirm times out, and when the submit throws", async () => {
    for (const [signature, error] of [
      [SIG, new ConfirmTimeoutError(SIG)],
      [null, new Error("connection dropped")],
    ] as const) {
      const records = heldRecords(ana, fakeStorage())
      await expect(
        run(
          deps(async (onSubmitted) => {
            if (signature) onSubmitted(signature)
            throw error
          }),
          records,
        ),
      ).rejects.toMatchObject({ name: "SentWithdrawalError" })
      expect(records.read()).toEqual([
        expect.objectContaining({
          request_id: REQUEST,
          at: 5_000,
          ...(signature ? { signature } : {}),
        }),
      ])
    }
  })

  it("drops it when the network refuses the transaction: nothing moved", async () => {
    const records = heldRecords(ana, fakeStorage())
    await expect(
      run(
        deps(async (onSubmitted) => {
          onSubmitted(SIG)
          throw failed()
        }),
        records,
      ),
    ).rejects.toMatchObject({ code: "transaction_failed" })
    expect(records.read()).toEqual([])
  })

  it("leaves nothing for a failure before the submit", async () => {
    const records = heldRecords(ana, fakeStorage())
    const d = deps(async () => receipt)
    d.signAndConfirm = vi.fn(async (_p, _c, onStep) => {
      onStep("signing")
      throw Object.assign(new Error("no"), { name: "UserRejectedRequestError" })
    })
    await expect(run(d, records)).rejects.toThrow()
    expect(records.read()).toEqual([])
  })

  it("refuses the same amount after a reload, and still allows another", async () => {
    const storage = fakeStorage()
    await expect(
      run(
        deps(async (onSubmitted) => {
          onSubmitted(SIG)
          throw new ConfirmTimeoutError(SIG)
        }),
        heldRecords(ana, storage),
      ),
    ).rejects.toBeDefined()

    // A hard reload: nothing in memory, only what the tab's storage kept.
    const held = heldOf(heldRecords(ana, storage).read())
    const reloaded = withdrawReducer(initialWithdraw, {
      type: "sync-held",
      held,
    })
    expect(reloaded.held).toEqual([{ amount: "1000000000", signature: SIG }])
    expect(
      withdrawReducer(reloaded, { type: "submit", amount: "1000000000" }),
    ).toBe(reloaded)
    expect(
      withdrawReducer(reloaded, { type: "submit", amount: "2000000000" }).stage,
    ).toBe("working")

    // Signed out and in as someone else on the same tab: nothing is held.
    const other = heldOf(heldRecords(bruno, storage).read())
    const fresh = withdrawReducer(initialWithdraw, {
      type: "sync-held",
      held: other,
    })
    expect(
      withdrawReducer(fresh, { type: "submit", amount: "1000000000" }).stage,
    ).toBe("working")
  })
})

describe("checking what became of a held withdrawal", () => {
  it("re-confirms with the saved request id and signature, and drops a confirmed one", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const confirm = confirmer(receipt)
    const { done, refresh } = check(records, confirm)
    expect(await done).toEqual([{ amount: "1000000000", outcome: "confirmed" }])
    expect(confirm).toHaveBeenCalledWith(
      { request_id: REQUEST, signature: SIG },
      expect.anything(),
    )
    expect(records.read()).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("drops one the network refused, so the amount is free again", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const { done, refresh } = check(records, confirmer(failed()))
    expect(await done).toEqual([{ amount: "1000000000", outcome: "failed" }])
    expect(records.read()).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps the amount held when the service cannot be reached", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const { done, refresh } = check(
      records,
      confirmer(new ApiError(0, "network_error")),
    )
    expect(await done).toEqual([{ amount: "1000000000", outcome: "unknown" }])
    expect(records.read()).toHaveLength(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("keeps it held when the answer is unreadable or the service no longer knows it", async () => {
    for (const answer of [
      new ApiError(404, "not_found"),
      new ApiError(500, "internal_error"),
    ]) {
      const records = heldRecords(ana, fakeStorage())
      records.upsert(record())
      const { done } = check(records, confirmer(answer))
      expect(await done).toEqual([{ amount: "1000000000", outcome: "unknown" }])
      expect(records.read()).toHaveLength(1)
    }
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const unreadable = vi.fn().mockRejectedValue(new TypeError("bad body"))
    expect(await check(records, unreadable).done).toEqual([
      { amount: "1000000000", outcome: "unknown" },
    ])
    expect(records.read()).toHaveLength(1)
  })

  it("waits out a transaction that is not finalized yet, then drops it as confirmed", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const confirm = confirmer(notFinalized(), notFinalized(), receipt)
    expect(await check(records, confirm).done).toEqual([
      { amount: "1000000000", outcome: "confirmed" },
    ])
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it("declares it lost only once the chain is past its last valid block, and only if the service said it was not on chain", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const confirm = confirmer(notFinalized())
    // Asked every 3 s (7.5 blocks) from 150 blocks before the last valid one: the 21st
    // wait takes the chain past it, and the ask after that is the last.
    const { height, blockHeight, sleep } = chain()
    const { done } = check(records, confirm, { blockHeight, sleep })
    expect(await done).toEqual([{ amount: "1000000000", outcome: "failed" }])
    expect(confirm).toHaveBeenCalledTimes(22)
    expect(height()).toBeGreaterThan(LAST_VALID)
    expect(records.read()).toEqual([])

    // The service never answered: past its blockhash it is still unknown, not lost.
    const silent = heldRecords(ana, fakeStorage())
    silent.upsert(record({ at: 1_000 }))
    const down = confirmer(new ApiError(503, "service_unavailable"))
    expect(await check(silent, down).done).toEqual([
      { amount: "1000000000", outcome: "unknown" },
    ])
    expect(silent.read()).toHaveLength(1)
  })

  it("does not wait again for one sent long ago: it is asked once and ruled on", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const confirm = confirmer(notFinalized())
    const { done } = check(records, confirm, {
      blockHeight: async () => LAST_VALID + 1_500,
    })
    expect(await done).toEqual([{ amount: "1000000000", outcome: "failed" }])
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it("asks nothing about a record with no last valid block height, and keeps it held", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record({ last_valid_block_height: undefined }))
    const confirm = confirmer(notFinalized())
    const { done } = check(records, confirm)
    expect(await done).toEqual([{ amount: "1000000000", outcome: "unknown" }])
    expect(confirm).not.toHaveBeenCalled()
    expect(records.read()).toHaveLength(1)
    expect(checkableKey(records.read())).toBe("")
  })

  it("asks nothing about a record with no signature, and keeps it held", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record({ signature: undefined }))
    records.upsert(record({ amount_units: "3", request_id: undefined }))
    const confirm = confirmer(receipt)
    const { done, refresh } = check(records, confirm)
    expect(await done).toEqual([
      { amount: "1000000000", outcome: "unknown" },
      { amount: "3", outcome: "unknown" },
    ])
    expect(confirm).not.toHaveBeenCalled()
    expect(records.read()).toHaveLength(2)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("settles each record on its own", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record({ amount_units: "1", signature: "A" }))
    records.upsert(record({ amount_units: "2", signature: "B" }))
    records.upsert(record({ amount_units: "3", signature: "C" }))
    const confirm = vi.fn(async (request: { signature: string }) => {
      if (request.signature === "A") return receipt
      if (request.signature === "B") throw failed()
      throw new ApiError(404, "not_found")
    })
    const { done, refresh } = check(records, confirm)
    expect((await done).map((c) => c.outcome)).toEqual([
      "confirmed",
      "failed",
      "unknown",
    ])
    expect(records.read().map((r) => r.amount_units)).toEqual(["3"])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("looks only at the records it is told to, and leaves the others untouched", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record({ amount_units: "1", signature: "A" }))
    records.upsert(record({ amount_units: "2", signature: "B" }))
    const confirm = confirmer(receipt)
    const { done } = check(records, confirm, {
      include: (r) => r.amount_units === "2",
    })
    expect(await done).toEqual([{ amount: "2", outcome: "confirmed" }])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(records.read().map((r) => r.amount_units)).toEqual(["1"])
  })

  it("stops when the screen is left, leaving every record as it was", async () => {
    const records = heldRecords(ana, fakeStorage())
    records.upsert(record())
    const controller = new AbortController()
    const confirm = confirmer(notFinalized())
    const { done } = check(records, confirm, {
      signal: controller.signal,
      sleep: async () => controller.abort(),
    })
    await expect(done).rejects.toBeDefined()
    expect(records.read()).toHaveLength(1)
  })

  it("does nothing when there is nothing held", async () => {
    const confirm = confirmer(receipt)
    const { done, refresh } = check(heldRecords(ana, fakeStorage()), confirm)
    expect(await done).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("checks only the viewer's own records", async () => {
    const storage = fakeStorage()
    heldRecords(bruno, storage).upsert(record({ amount_units: "9" }))
    const confirm = confirmer(receipt)
    const { done } = check(heldRecords(ana, storage), confirm)
    expect(await done).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    expect(heldRecords(bruno, storage).read()).toHaveLength(1)
  })

  it("works through a check when storage is unavailable, in memory", async () => {
    const records = heldRecords(ana, blocked)
    records.upsert(record())
    const { done } = check(records, confirmer(receipt))
    expect(await done).toEqual([{ amount: "1000000000", outcome: "confirmed" }])
    expect(records.read()).toEqual([])
  })
})

describe("heldCheckMessage", () => {
  it("says what a settled withdrawal came to", () => {
    expect(
      heldCheckMessage({ amount: "1000000000", outcome: "confirmed" }),
    ).toBe("Your last withdrawal of $1,000.00 went through.")
    expect(heldCheckMessage({ amount: "1000000000", outcome: "failed" })).toBe(
      "Your last withdrawal of $1,000.00 didn't go through, so nothing was withdrawn. You can withdraw again.",
    )
  })

  it("says nothing for one that is still unknown: the held notice does", () => {
    expect(
      heldCheckMessage({ amount: "1000000000", outcome: "unknown" }),
    ).toBeNull()
  })
})

describe("a saved amount that is not canonical", () => {
  it("is set aside as unreadable, so the whole list is held, rather than read as a number", () => {
    const storage = fakeStorage()
    const key = `cadence:submissions:withdraw:${viewerScopeId(ana)}`
    storage.setItem(
      key,
      JSON.stringify([
        { amount_units: "0500000000", at: 1 },
        { amount_units: "500000000", at: 1 },
      ]),
    )

    const list = heldRecords(ana, storage)

    expect(list.read().map((r) => r.amount_units)).toEqual(["500000000"])
    expect(list.unreadable()).toBe(true)
  })

  it("reads 0 and ordinary amounts, and refuses a sign, a space or a decimal point", () => {
    for (const amount of ["0", "1", "1234560000", "99999999999999999999"]) {
      expect(
        heldRecordSchema.safeParse({ amount_units: amount, at: 1 }).success,
      ).toBe(true)
    }
    for (const amount of [
      "",
      "00",
      "01",
      "-1",
      "+1",
      " 1",
      "1.5",
      "1e6",
      "123456789012345678901",
    ]) {
      expect(
        heldRecordSchema.safeParse({ amount_units: amount, at: 1 }).success,
        amount,
      ).toBe(false)
    }
  })
})
