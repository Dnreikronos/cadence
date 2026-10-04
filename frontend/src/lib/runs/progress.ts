import type { PaymentStatus } from "@/lib/api/schemas"
import { expiredMessage, failureCodeMessage, type Failure } from "./messages"

// What a payment in a run looks like on screen: the server's status, with what this
// browser is doing to it laid over the top (`signing` and `waiting` exist only here).
export type RowStatus =
  "pending" | "signing" | "waiting" | "confirmed" | "failed" | "expired"

export type LocalRow = {
  status: "signing" | "waiting" | "confirmed" | "failed"
  signature?: string
  message?: string
  // Waiting on a transaction that is already on the network.
  stalled?: boolean
}

export type LocalRows = Record<string, LocalRow>

export type LocalAction =
  | { type: "signing"; id: string }
  | { type: "waiting"; id: string }
  | { type: "submitted"; id: string; signature: string }
  | { type: "confirmed"; id: string }
  | ({ type: "failed"; id: string } & Failure)

export function localReducer(state: LocalRows, action: LocalAction): LocalRows {
  const current = state[action.id]
  switch (action.type) {
    case "signing":
      return { ...state, [action.id]: { status: "signing" } }
    case "waiting":
      return {
        ...state,
        [action.id]: { ...current, status: "waiting", stalled: false },
      }
    case "submitted":
      return {
        ...state,
        [action.id]: {
          ...current,
          status: "waiting",
          signature: action.signature,
        },
      }
    case "confirmed":
      return {
        ...state,
        [action.id]: { status: "confirmed", signature: current?.signature },
      }
    case "failed":
      // A stalled payment stays "waiting": it may still land, so it is checked, not retried.
      return {
        ...state,
        [action.id]: {
          status: action.stalled ? "waiting" : "failed",
          signature: action.signature ?? current?.signature,
          message: action.message,
          stalled: action.stalled,
        },
      }
  }
}

export type ServerRow = { status: PaymentStatus; failure: string | null }

export type Row = {
  status: RowStatus
  message: string | null
  // Waiting on the network for a transaction already sent: offer "Check again".
  stalled: boolean
  signature: string | null
}

const inFlight = (status: LocalRow["status"]) =>
  status === "signing" || status === "waiting"

// One status per payment. In-flight work here is the freshest truth; a confirmation
// never un-confirms; otherwise a final answer from the server beats what this browser
// last saw (a payment that fails on the network is later reported `expired`).
// `signed` is undefined in the contract, so it displays as pending.
export function mergeRow(local?: LocalRow, server?: ServerRow): Row {
  const signature = local?.signature ?? null
  if (local && inFlight(local.status)) {
    return {
      status: local.status,
      message: local.message ?? null,
      stalled: local.stalled ?? false,
      signature,
    }
  }
  if (local?.status === "confirmed") {
    return { status: "confirmed", message: null, stalled: false, signature }
  }
  if (server?.status === "confirmed") {
    return { status: "confirmed", message: null, stalled: false, signature }
  }
  if (server?.status === "expired") {
    return {
      status: "expired",
      message: expiredMessage,
      stalled: false,
      signature,
    }
  }
  if (server?.status === "failed" || local?.status === "failed") {
    return {
      status: "failed",
      message: local?.message ?? failureCodeMessage(server?.failure ?? null),
      stalled: false,
      signature,
    }
  }
  return { status: "pending", message: null, stalled: false, signature }
}

export const isSettled = (status: RowStatus) =>
  status === "confirmed" || status === "failed" || status === "expired"

export const canRetry = (row: Row) =>
  row.status === "failed" || row.status === "expired"

export function tally(rows: readonly Row[]) {
  const count = (status: RowStatus) =>
    rows.filter((row) => row.status === status).length
  const confirmed = count("confirmed")
  const failed = count("failed") + count("expired")
  const open = rows.length - confirmed - failed
  return { total: rows.length, confirmed, failed, open }
}
