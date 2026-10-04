import { describe, expect, it } from "vitest"
import {
  clearSubmission,
  readSubmission,
  recordSubmission,
  type SubmissionStorage,
} from "./submissions"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const throwing: SubmissionStorage = {
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

const record = {
  kind: "wrap",
  request_id: "a".repeat(64),
  signature: null,
  last_valid_block_height: 1234,
  wallet: "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5",
  at: 1_000,
}

describe("submissions", () => {
  it("reads back what was recorded", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    expect(readSubmission("wrap", storage)).toEqual(record)
  })

  it("stamps the time when none is given", () => {
    const storage = fakeStorage()
    const before = Date.now()
    const saved = recordSubmission({ ...record, at: undefined }, storage)
    expect(saved.at).toBeGreaterThanOrEqual(before)
    expect(readSubmission("wrap", storage)?.at).toBe(saved.at)
  })

  it("keeps one record per kind and lets a newer one replace the last", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    recordSubmission({ ...record, kind: "unwrap", request_id: "b" }, storage)
    recordSubmission({ ...record, signature: "SIG" }, storage)
    expect(readSubmission("wrap", storage)?.signature).toBe("SIG")
    expect(readSubmission("unwrap", storage)?.request_id).toBe("b")
  })

  it("clears one kind and leaves the others", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    recordSubmission({ ...record, kind: "unwrap" }, storage)
    clearSubmission("wrap", storage)
    expect(readSubmission("wrap", storage)).toBeNull()
    expect(readSubmission("unwrap", storage)).not.toBeNull()
  })

  it("is null when nothing was recorded", () => {
    expect(readSubmission("wrap", fakeStorage())).toBeNull()
  })

  it("drops a stored value that is not a record", () => {
    const storage = fakeStorage()
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ ...record, last_valid_block_height: -1 }),
      JSON.stringify({ ...record, kind: "other" }),
    ]) {
      storage.items.set("cadence:submission:wrap", bad)
      expect(readSubmission("wrap", storage)).toBeNull()
      expect(storage.items.has("cadence:submission:wrap")).toBe(false)
    }
  })

  it("works without storage: nothing throws and nothing is found", () => {
    for (const storage of [null, throwing]) {
      expect(() => recordSubmission(record, storage)).not.toThrow()
      expect(readSubmission("wrap", storage)).toBeNull()
      expect(() => clearSubmission("wrap", storage)).not.toThrow()
    }
  })

  it("returns the record it tried to save even when storage refuses", () => {
    expect(recordSubmission(record, throwing)).toEqual(record)
  })
})
