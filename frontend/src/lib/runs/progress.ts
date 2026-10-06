import { isKnownRunPaymentStatus } from "@/lib/api/schemas"
import {
  expiredMessage,
  failureCodeMessage,
  notSentMessage,
  unrecognizedMessage,
  type Failure,
} from "./messages"

// What a payment in a run looks like on screen: the server's status, with what this
// browser is doing to it laid over the top. `signing`, `waiting` and `unknown` exist
// only here; `unknown` is a payment that may have been sent with no signature to ask about.
// `cancelled` is a signature the person turned down: nothing was sent, and the prepared
// transaction is still held, so it is signed again, never retried (the service refuses a
// retry while a prepared transaction can still land).
// `pending` is a prepared payment this page holds and has not signed yet; `not-sent` one
// it does not hold and never sent: its transaction cannot land from here, so it was not
// paid in this run.
export type RowStatus =
  | "pending"
  | "not-sent"
  | "signing"
  | "waiting"
  | "unknown"
  | "cancelled"
  // The service sent a status this app does not know: the payment may be in flight or
  // paid, so no action is offered for it.
  | "unrecognized"
  | "confirmed"
  | "failed"
  | "expired"

export type LocalRow = {
  status:
    "signing" | "waiting" | "unknown" | "cancelled" | "confirmed" | "failed"
  signature?: string
  message?: string
  // Sent and not confirmed yet: it can only be asked about again, never replaced.
  stalled?: boolean
}

export type LocalRows = Record<string, LocalRow>

export type LocalAction =
  // A retry prepared the payment again: what this page saw of the old attempt is over.
  | { type: "reset"; id: string }
  | { type: "signing"; id: string }
  | { type: "waiting"; id: string }
  | { type: "submitted"; id: string; signature: string }
  | { type: "confirmed"; id: string }
  | ({ type: "failed"; id: string; cancelled?: boolean } & Failure)

export function localReducer(state: LocalRows, action: LocalAction): LocalRows {
  const current = state[action.id]
  switch (action.type) {
    case "reset": {
      const rest = { ...state }
      delete rest[action.id]
      return rest
    }
    case "signing":
      return { ...state, [action.id]: { status: "signing" } }
    case "waiting":
      return {
        ...state,
        [action.id]: {
          status: "waiting",
          signature: current?.signature,
          stalled: false,
        },
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
    case "failed": {
      // Cancelled before anything was sent: it can be signed again.
      if (!action.sent && action.cancelled) {
        return {
          ...state,
          [action.id]: { status: "cancelled", message: action.message },
        }
      }
      if (!action.sent) {
        return {
          ...state,
          [action.id]: {
            status: "failed",
            signature: current?.signature,
            message: action.message,
          },
        }
      }
      // Sent: with a signature it stays "waiting" and can be checked again; without one
      // it is "unknown". Neither is ever retried.
      const signature = action.signature ?? current?.signature
      return {
        ...state,
        [action.id]: signature
          ? {
              status: "waiting",
              stalled: true,
              signature,
              message: action.message,
            }
          : { status: "unknown", message: action.message },
      }
    }
  }
}

// The status is whatever the service sent, and its stable error code.
export type ServerRow = { status: string; error: string | null }

export type Row = {
  status: RowStatus
  message: string | null
  // Sent and not confirmed: offer "Check again" (when there is a signature), never Retry.
  stalled: boolean
  signature: string | null
}

// One status per payment. The server saying `finalized` ends it, whatever this browser
// last saw. Otherwise work in flight here, and a payment that may have been sent, are
// the freshest truth and stay put until it is confirmed or the network rejects it. A
// confirmation never un-confirms. Last, a final answer from the server beats what this
// browser saw. `held` is whether this page still holds the payment's transaction.
export function mergeRow(
  local?: LocalRow,
  server?: ServerRow,
  held = false,
): Row {
  const known = server && isKnownRunPaymentStatus(server.status)
  const unrecognized = !!server && !known
  const status = known ? server.status : undefined
  const signature = local?.signature ?? null
  const row = (
    rowStatus: RowStatus,
    message: string | null = null,
    stalled = false,
  ): Row => ({ status: rowStatus, message, stalled, signature })
  if (status === "finalized" || local?.status === "confirmed") {
    return row("confirmed")
  }
  const failed =
    status === "failed" ||
    status === "expired" ||
    status === "preparation_failed"
  // A cancelled signature counts only while its transaction is held, and a final answer
  // from the server beats it, as does a status that may mean it is in flight.
  if (
    local &&
    local.status !== "failed" &&
    !(local.status === "cancelled" && (failed || unrecognized || !held))
  ) {
    return row(local.status, local.message ?? null, local.stalled ?? false)
  }
  if (unrecognized) return row("unrecognized", unrecognizedMessage)
  if (status === "expired") return row("expired", expiredMessage)
  if (failed || local?.status === "failed") {
    return row(
      "failed",
      (local?.status === "failed" ? local.message : undefined) ??
        failureCodeMessage(server?.error ?? null),
    )
  }
  return held ? row("pending") : row("not-sent", notSentMessage)
}

export const isSettled = (status: RowStatus) =>
  status === "confirmed" ||
  status === "failed" ||
  status === "expired" ||
  status === "not-sent"

// A new transaction is only ever prepared for a payment that did not land: the run's
// retry covers every such row at once.
export const canRetry = (row: Row) =>
  row.status === "failed" || row.status === "expired"

// A cancelled signature is signed again from the transaction held in memory.
export const canSignAgain = (row: Row) => row.status === "cancelled"

export const canRecheck = (row: Row) => row.stalled && row.signature !== null

export function tally(rows: readonly Row[]) {
  const count = (test: (row: Row) => boolean) => rows.filter(test).length
  const confirmed = count((row) => row.status === "confirmed")
  const retryable = count(canRetry)
  // Signature cancelled: not sent, waiting for the person to sign again.
  const cancelled = count(canSignAgain)
  // A status this app does not know: it may be in flight, so nothing is offered.
  const unrecognized = count((row) => row.status === "unrecognized")
  // Sent and not confirmed, with or without a signature to ask about.
  const sent = count((row) => row.stalled || row.status === "unknown")
  // Never sent and no longer held: not paid in this run.
  const notSent = count((row) => row.status === "not-sent")
  const attention = retryable + cancelled + unrecognized + sent + notSent
  return {
    total: rows.length,
    confirmed,
    retryable,
    cancelled,
    unrecognized,
    sent,
    notSent,
    attention,
    open: rows.length - confirmed - attention,
  }
}

// Whether leaving the page would lose something that cannot be recovered: a payment
// being signed, one that was sent and whose signature exists only on this screen, or a
// cancelled one whose prepared transaction is held only in this session.
export function holdsUnconfirmed(local: LocalRows) {
  return Object.values(local).some(
    (row) =>
      row.status === "signing" ||
      row.status === "waiting" ||
      row.status === "cancelled" ||
      row.status === "unknown",
  )
}
