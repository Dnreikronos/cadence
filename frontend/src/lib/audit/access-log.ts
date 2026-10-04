import type { AccessLogItem } from "@/lib/api/schemas"

const actorKinds: Record<string, string> = {
  service: "Cadence",
  company: "Company",
  recipient: "Recipient",
  auditor: "Auditor",
}

const actions: Record<string, string> = {
  read_payments: "Read payments",
  read_balance: "Read balance",
  export_csv: "Exported a CSV",
}

// The service may add kinds and actions: one this app does not know is shown as sent.
const known = (labels: Record<string, string>, value: string) =>
  Object.hasOwn(labels, value) ? labels[value] : value

export const actorKindLabel = (kind: string) => known(actorKinds, kind)
export const actionLabel = (action: string) => known(actions, action)

// `key` is for React only; it is never shown.
export type AccessRow = {
  key: string
  at: string
  who: string
  kind: string
  action: string
  scope: string
}

export function accessRow(item: AccessLogItem): AccessRow {
  return {
    key: item.id,
    at: item.at,
    who: item.actor.label,
    kind: actorKindLabel(item.actor.kind),
    action: actionLabel(item.action),
    scope: item.scope,
  }
}
