import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import {
  AmountNotSavedError,
  DuplicateEmailError,
  PeopleNotConfiguredError,
  peopleMessageFor,
} from "./errors"
import { PAGE_ROWS, readRows } from "./paging"
import {
  clearInviteStale,
  isInviteStale,
  markInviteStale,
} from "./stale-invites"
import { inviteFailureCopy, saveSuccessCopy, saveWarningCopy } from "./toasts"

const input = {
  name: "Aline Prado",
  email: "aline@prado.test",
  kind: "contractor",
} as const

describe("toast copy", () => {
  it("names a new person and says changes saved for an edit", () => {
    expect(saveSuccessCopy({ id: "x", inviteStale: false }, { input })).toEqual(
      { message: "Aline Prado added" },
    )
    expect(
      saveSuccessCopy({ id: "x", inviteStale: false }, { id: "x", input }),
    ).toEqual({ message: "Changes saved" })
  })

  it("says the invite is useless after an email change on an invited person", () => {
    const copy = saveSuccessCopy(
      { id: "x", inviteStale: true },
      { id: "x", input },
    )
    expect(copy.message).toBe("Changes saved")
    expect(copy.description).toMatch(/invite already sent won't work/)
  })

  it("warns about a missing amount for a new person only", () => {
    const failed = new AmountNotSavedError(
      new ApiError(503, "auth_unavailable"),
    )
    expect(saveWarningCopy(failed, { input })).toMatch(
      /^Saved, but the monthly amount wasn't/,
    )
    expect(saveWarningCopy(failed, { id: "x", input })).toBeNull()
    expect(saveWarningCopy(new DuplicateEmailError(), { input })).toBeNull()
  })

  it("offers a retry for a busy service but not straight after a rate limit", () => {
    expect(inviteFailureCopy(new ApiError(503, "auth_unavailable"))).toEqual({
      message: expect.stringMatching(/unavailable/),
      retry: true,
    })
    expect(
      inviteFailureCopy(new ApiError(429, "transfer_rate_limited")),
    ).toEqual({
      message: "Too many invites sent. Wait a moment and try again.",
      retry: false,
    })
  })

  it("gives the invite conflicts their copy and no retry", () => {
    expect(
      inviteFailureCopy(new ApiError(409, "person_already_active")),
    ).toEqual({ message: "This person already has an account.", retry: false })
  })

  it("never shows an amount or the raw error", () => {
    const copy = inviteFailureCopy(new Error("amount 4200 leaked"))
    expect(copy.message).not.toMatch(/4200|leaked/)
  })

  it("says sign-in is not configured, not that the connection is bad", () => {
    expect(peopleMessageFor(new PeopleNotConfiguredError())).toMatch(
      /Sign-in is not configured/,
    )
    expect(peopleMessageFor(new PeopleNotConfiguredError())).not.toMatch(
      /connection/i,
    )
  })
})

describe("stale invites", () => {
  it("remembers a person until a new invite clears it", () => {
    expect(isInviteStale("p-stale")).toBe(false)
    markInviteStale("p-stale")
    expect(isInviteStale("p-stale")).toBe(true)
    clearInviteStale("p-stale")
    expect(isInviteStale("p-stale")).toBe(false)
  })
})

describe("readRows", () => {
  const table = (count: number) =>
    Array.from({ length: count }, (_, index) => index)
  const reader = (rows: number[]) => async (from: number, to: number) =>
    rows.slice(from, to + 1)

  it("reads a short table in one request", async () => {
    const calls: [number, number][] = []
    const rows = table(3)
    const read = await readRows(async (from, to) => {
      calls.push([from, to])
      return rows.slice(from, to + 1)
    }, 100)
    expect(read).toEqual({ rows, truncated: false })
    expect(calls).toEqual([[0, 99]])
  })

  it("keeps asking while a page comes back full", async () => {
    const read = await readRows(reader(table(2 * PAGE_ROWS + 7)), 10_000)
    expect(read.rows).toHaveLength(2 * PAGE_ROWS + 7)
    expect(read.truncated).toBe(false)
  })

  it("says truncated only when a row exists past the limit", async () => {
    expect(await readRows(reader(table(10)), 10, 4)).toEqual({
      rows: table(10),
      truncated: false,
    })
    expect(await readRows(reader(table(11)), 10, 4)).toEqual({
      rows: table(10),
      truncated: true,
    })
  })

  it("never asks for more rows than the limit allows in one page", async () => {
    const asked: [number, number][] = []
    await readRows(
      async (from, to) => {
        asked.push([from, to])
        return table(100).slice(from, to + 1)
      },
      10,
      4,
    )
    expect(asked).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
      [10, 10],
    ])
  })
})
