import { describe, expect, it } from "vitest"
import { queryKeys } from "./keys"

const ana = { email: "ana@solaris.test", company: "Solaris" }
const bruno = { email: "bruno@solaris.test", company: "Solaris" }

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
      [queryKeys.balance.company(ana), queryKeys.balance.all],
      [queryKeys.balance.me(ana), queryKeys.balance.all],
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
    expect(queryKeys.balance.company(ana)).not.toEqual(
      queryKeys.balance.me(ana),
    )
    expect(queryKeys.runs.detail("a")).not.toEqual(queryKeys.runs.detail("b"))
  })

  it("keeps one viewer's balance apart from another's", () => {
    expect(queryKeys.balance.me(ana)).not.toEqual(queryKeys.balance.me(bruno))
    expect(queryKeys.balance.me(ana)).not.toEqual(
      queryKeys.balance.me({ ...ana, company: "Acme" }),
    )
  })

  it("is stable for the same input", () => {
    expect(queryKeys.payments.audit("c", { limit: 10 })).toEqual(
      queryKeys.payments.audit("c", { limit: 10 }),
    )
  })
})
