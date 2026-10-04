import { describe, expect, it } from "vitest"
import { queryKeys } from "./keys"

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part)

describe("queryKeys", () => {
  it("keeps the people and deposit prefixes the existing screens already use", () => {
    expect(queryKeys.people.all).toEqual(["people"])
    expect(queryKeys.deposit.all).toEqual(["deposit"])
  })

  it("extends each group's prefix, so invalidating `all` reaches every key", () => {
    const keys = [
      [queryKeys.people.list(), queryKeys.people.all],
      [queryKeys.people.detail("a"), queryKeys.people.all],
      [queryKeys.people.amounts(), queryKeys.people.all],
      [queryKeys.balance.company(), queryKeys.balance.all],
      [queryKeys.balance.me(), queryKeys.balance.all],
      [queryKeys.deposit.info(), queryKeys.deposit.all],
      [queryKeys.payments.company(), queryKeys.payments.all],
      [queryKeys.payments.me(), queryKeys.payments.all],
      [queryKeys.payments.audit("c"), queryKeys.payments.all],
      [queryKeys.runs.detail("r"), queryKeys.runs.all],
      [queryKeys.auditors.list(), queryKeys.auditors.all],
      [queryKeys.accessLog.list(), queryKeys.accessLog.all],
      [queryKeys.status.me(), queryKeys.status.all],
      [queryKeys.receipts.list(), queryKeys.receipts.all],
      [queryKeys.receipts.detail("p"), queryKeys.receipts.all],
    ] as const
    for (const [key, prefix] of keys) expect(startsWith(key, prefix)).toBe(true)
  })

  it("tells different pages and scopes apart", () => {
    expect(queryKeys.payments.company({ cursor: "a" })).not.toEqual(
      queryKeys.payments.company({ cursor: "b" }),
    )
    expect(queryKeys.payments.company()).not.toEqual(queryKeys.payments.me())
    expect(queryKeys.balance.company()).not.toEqual(queryKeys.balance.me())
    expect(queryKeys.runs.detail("a")).not.toEqual(queryKeys.runs.detail("b"))
  })

  it("is stable for the same input", () => {
    expect(queryKeys.payments.audit("c", { limit: 10 })).toEqual(
      queryKeys.payments.audit("c", { limit: 10 }),
    )
  })
})
