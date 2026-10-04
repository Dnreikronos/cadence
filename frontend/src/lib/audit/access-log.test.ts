import { describe, expect, it } from "vitest"
import type { AccessLogItem } from "@/lib/api/schemas"
import { accessRow, actionLabel, actorKindLabel } from "./access-log"

const entry: AccessLogItem = {
  id: "e0000000-0000-4000-8000-000000000001",
  at: "2026-10-03T18:00:00Z",
  actor: { kind: "auditor", label: "Ana Ribeiro" },
  action: "read_payments",
  scope: "Company payments",
}

describe("labels", () => {
  it.each([
    ["service", "Cadence"],
    ["company", "Company"],
    ["recipient", "Recipient"],
    ["auditor", "Auditor"],
  ])("names the actor kind %s", (kind, label) => {
    expect(actorKindLabel(kind)).toBe(label)
  })

  it.each([
    ["read_payments", "Read payments"],
    ["read_balance", "Read balance"],
    ["export_csv", "Exported a CSV"],
  ])("names the action %s", (action, label) => {
    expect(actionLabel(action)).toBe(label)
  })

  it("shows a kind or action it does not know as sent", () => {
    expect(actorKindLabel("regulator")).toBe("regulator")
    expect(actionLabel("read_audit_trail")).toBe("read_audit_trail")
  })

  it("does not mistake an inherited property for a label", () => {
    expect(actorKindLabel("constructor")).toBe("constructor")
    expect(actionLabel("toString")).toBe("toString")
    expect(actionLabel("__proto__")).toBe("__proto__")
  })
})

describe("accessRow", () => {
  it("maps an entry for the list", () => {
    expect(accessRow(entry)).toEqual({
      key: entry.id,
      at: "2026-10-03T18:00:00Z",
      who: "Ana Ribeiro",
      kind: "Auditor",
      action: "Read payments",
      scope: "Company payments",
    })
  })

  it("renders unknown values as the raw strings", () => {
    const row = accessRow({
      ...entry,
      actor: { kind: "regulator", label: "SEC" },
      action: "read_audit_trail",
    })
    expect(row).toMatchObject({
      who: "SEC",
      kind: "regulator",
      action: "read_audit_trail",
    })
  })
})

describe("what a row shows", () => {
  it("never carries the entry id among the fields that are rendered", () => {
    const { key, ...shown } = accessRow(entry)
    expect(key).toBe(entry.id)
    expect(JSON.stringify(Object.values(shown))).not.toContain(entry.id)
  })
})
