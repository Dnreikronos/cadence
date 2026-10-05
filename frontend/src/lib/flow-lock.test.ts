import { describe, expect, it, vi } from "vitest"
import {
  acquireFlowLock,
  flowLockName,
  otherTabMessage,
  type ChannelLike,
  type LockManagerLike,
} from "./flow-lock"

// A lock manager as the browser's: `ifAvailable` gives the callback null when the lock is
// taken, and the lock lasts until the callback's promise settles.
function fakeLocks() {
  const held = new Set<string>()
  const locks: LockManagerLike = {
    request: async (name, _options, callback) => {
      if (held.has(name)) return callback(null)
      held.add(name)
      try {
        return await callback({ name })
      } finally {
        held.delete(name)
      }
    },
  }
  return { locks, held }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("flowLockName", () => {
  it("is one name per flow kind and viewer, and never holds an email", () => {
    const ana = { company: "Solaris", email: "ana@example.com" }
    const name = flowLockName("withdraw", ana)
    expect(name).toMatch(/^cadence:flow:withdraw:[0-9a-f]{16}$/)
    expect(flowLockName("payroll", ana)).not.toBe(name)
    expect(flowLockName("withdraw", { ...ana, email: "b@x.io" })).not.toBe(name)
    expect(flowLockName("withdraw", { ...ana, companyId: "id-1" })).not.toBe(
      name,
    )
  })

  it("says what to wait for, in plain words", () => {
    expect(otherTabMessage("withdrawal")).toBe(
      "Another tab is sending or checking a withdrawal for this account: wait for it to finish.",
    )
    expect(otherTabMessage("run")).toContain("a run")
  })
})

describe("with Web Locks", () => {
  it("holds the lock until the lease is released, and a second taker is refused meanwhile", async () => {
    const { locks, held } = fakeLocks()
    const first = await acquireFlowLock("w", { locks })
    expect(first.status).toBe("held")
    expect(held.has("w")).toBe(true)

    // Another tab (or this one) asking while it is held is told to wait.
    expect((await acquireFlowLock("w", { locks })).status).toBe("busy")

    if (first.status !== "held") throw new Error("unreachable")
    first.lease.release()
    await tick()
    expect(held.has("w")).toBe(false)
    const again = await acquireFlowLock("w", { locks })
    expect(again.status).toBe("held")
  })

  it("never waits for a lock that is taken", async () => {
    const { locks } = fakeLocks()
    const request = vi.spyOn(locks, "request")
    await acquireFlowLock("w", { locks })
    await acquireFlowLock("w", { locks })
    for (const call of request.mock.calls) {
      expect(call[1]).toEqual({ ifAvailable: true })
    }
  })

  it("keeps flows apart: a withdrawal does not wait for a run, nor one viewer for another", async () => {
    const { locks } = fakeLocks()
    expect((await acquireFlowLock("withdraw:a", { locks })).status).toBe("held")
    expect((await acquireFlowLock("payroll:a", { locks })).status).toBe("held")
    expect((await acquireFlowLock("withdraw:b", { locks })).status).toBe("held")
    expect((await acquireFlowLock("withdraw:a", { locks })).status).toBe("busy")
  })

  it("lets a lease be released twice without freeing someone else's lock", async () => {
    const { locks, held } = fakeLocks()
    const first = await acquireFlowLock("w", { locks })
    if (first.status !== "held") throw new Error("unreachable")
    first.lease.release()
    await tick()
    const second = await acquireFlowLock("w", { locks })
    first.lease.release()
    await tick()
    expect(held.has("w")).toBe(true)
    expect(second.status).toBe("held")
  })

  it("falls back when the lock manager refuses (an insecure page)", async () => {
    const locks: LockManagerLike = {
      request: () => Promise.reject(new DOMException("insecure")),
    }
    const result = await acquireFlowLock("w", { locks })
    // No channel to ask either: nothing to coordinate with, so it goes on.
    expect(result.status).toBe("held")
  })
})

// A BroadcastChannel between two fake tabs.
function fakeBus() {
  const listeners = new Set<(e: { data: unknown }) => void>()
  const channel = (): ChannelLike => {
    let mine: ((e: { data: unknown }) => void) | undefined
    return {
      postMessage: (data) => {
        for (const listener of listeners) {
          if (listener !== mine) queueMicrotask(() => listener({ data }))
        }
      },
      addEventListener: (_type, listener) => {
        mine = listener
        listeners.add(listener)
      },
      close: () => {
        if (mine) listeners.delete(mine)
      },
    }
  }
  return { channel }
}

describe("without Web Locks", () => {
  const sleep = () => tick()

  it("goes on when no other tab answers", async () => {
    const bus = fakeBus()
    const result = await acquireFlowLock("w", {
      locks: null,
      channel: bus.channel,
      sleep,
    })
    expect(result.status).toBe("held")
  })

  it("only warns when another tab is holding the flow: it still goes on", async () => {
    const bus = fakeBus()
    const first = await acquireFlowLock("w", {
      locks: null,
      channel: bus.channel,
      sleep,
    })
    expect(first.status).toBe("held")
    const second = await acquireFlowLock("w", {
      locks: null,
      channel: bus.channel,
      sleep,
    })
    expect(second.status).toBe("maybe-busy")
    // A warning is not a refusal: there is a lease to hold and release.
    if (second.status !== "maybe-busy") throw new Error("unreachable")
    second.lease.release()
  })

  it("stops answering once the first tab is done", async () => {
    const bus = fakeBus()
    const first = await acquireFlowLock("w", {
      locks: null,
      channel: bus.channel,
      sleep,
    })
    if (first.status !== "held") throw new Error("unreachable")
    first.lease.release()
    const second = await acquireFlowLock("w", {
      locks: null,
      channel: bus.channel,
      sleep,
    })
    expect(second.status).toBe("held")
  })

  it("goes on when there is nothing to ask with either", async () => {
    expect((await acquireFlowLock("w", { locks: null })).status).toBe("held")
    expect(
      (await acquireFlowLock("w", { locks: null, channel: () => null })).status,
    ).toBe("held")
  })
})
