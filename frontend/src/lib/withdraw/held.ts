import { z } from "zod"
import type { ApiClient } from "@/lib/api/client"
import { reconcileWrap, type Reconciled } from "@/lib/deposit/reconcile"
import { formatUnits } from "@/lib/money"
import {
  createRecordList,
  viewerScopeId,
  type RecordList,
  type SubmissionStorage,
} from "@/lib/submissions"
import type { Held } from "./flow"

// A withdrawal that may have gone through, kept so a reload (or signing out and back
// in) cannot forget it and offer the same amount again. It holds the amount, which
// the other submission records do not: this is why it lives in this tab's
// `sessionStorage` only, per viewer, and is dropped once the outcome is known.
// `request_id` and `last_valid_block_height` are there from the moment of sending;
// the signature once the network returned one. A record without a signature
// cannot be asked about: it stays until the tab closes.
export const heldRecordSchema = z.object({
  amount_units: z.string().regex(/^\d{1,20}$/),
  request_id: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
  last_valid_block_height: z.number().int().nonnegative().optional(),
  // Epoch milliseconds when it was sent: the 90-second rule counts from here.
  at: z.number().int().nonnegative(),
})
export type HeldRecord = z.infer<typeof heldRecordSchema>

export const WITHDRAW_KIND = "withdraw"

export type HeldRecords = RecordList<HeldRecord>

// One record per amount: the same amount is never sent twice while one is unresolved.
export function heldRecords(
  viewer: { company: string; email: string },
  storage?: SubmissionStorage | null,
): HeldRecords {
  return createRecordList({
    kind: WITHDRAW_KIND,
    scope: viewerScopeId(viewer),
    schema: heldRecordSchema,
    same: (a, b) => a.amount_units === b.amount_units,
    ...(storage === undefined ? {} : { storage }),
  })
}

const lists = new Map<string, HeldRecords>()

// The viewer's list for this tab, the same object each time so every screen and hook
// sees one another's writes. It also outlives the query cache, which sign-out clears:
// the next person signing in reads their own scope and none of this one's.
export function heldRecordsFor(viewer: { company: string; email: string }) {
  const scope = viewerScopeId(viewer)
  let list = lists.get(scope)
  if (!list) {
    list = heldRecords(viewer)
    lists.set(scope, list)
  }
  return list
}

export const toHeld = (record: HeldRecord): Held => ({
  amount: record.amount_units,
  signature: record.signature ?? null,
})

// The list the reducer refuses amounts from.
export const heldOf = (records: readonly HeldRecord[]): readonly Held[] =>
  records.map(toHeld)

// The evidence of a withdrawal as the flow gives it: at the moment of sending (no
// signature) and again once the network returned the signature.
export type SentEvidence = {
  request_id: string
  last_valid_block_height: number
  signature: string | null
}

// What to write for a withdrawal of `amount` sent at `at`.
export function recordFor(
  amount: string,
  evidence: SentEvidence,
  at: number,
): HeldRecord {
  return {
    amount_units: amount,
    request_id: evidence.request_id,
    last_valid_block_height: evidence.last_valid_block_height,
    ...(evidence.signature ? { signature: evidence.signature } : {}),
    at,
  }
}

// What `runWithdraw` calls as the transaction is sent and when its outcome is final,
// writing to the viewer's records. The time it was sent is kept when the signature is
// added, since the 90-second rule counts from the send.
export function withdrawEvidence(
  records: HeldRecords,
  amount: string,
  now: () => number = Date.now,
) {
  return {
    onSent: (evidence: SentEvidence) => {
      const earlier = records
        .read()
        .find((record) => record.amount_units === amount)
      const at =
        earlier?.request_id === evidence.request_id ? earlier.at : now()
      records.upsert(recordFor(amount, evidence, at))
    },
    onResolved: () =>
      records.remove((record) => record.amount_units === amount),
  }
}

// ---- Looking at what became of them ------------------------------------------

// What a check of one held withdrawal found.
// - confirmed: it landed. The record is gone.
// - failed: the network refused it, or it was seen missing until its blockhash ran out
//   (90 s after sending). Nothing moved, the record is gone and the amount is free.
// - unknown: it may or may not have landed, so the amount stays held. No signature to
//   ask about, a service that could not be reached, or one that no longer has it.
export type HeldCheck = { amount: string; outcome: Reconciled }

type CheckInput = {
  records: HeldRecords
  api: { unwrap: Pick<ApiClient["unwrap"], "confirm"> }
  // Balances may have changed: a withdrawal was found confirmed or not to have landed.
  refresh: () => void
  // Only these are looked up (default: every record). The others are left as they are.
  include?: (record: HeldRecord) => boolean
  signal?: AbortSignal
  now?: () => number
  sleep?: Parameters<typeof reconcileWrap>[0]["sleep"]
  pollMs?: number
}

// Re-confirms every held withdrawal that has a signature, which the service answers
// idempotently for one signature: it never prepares anything new. A record is dropped
// only on an answer that is final; anything else keeps the amount held. Aborting
// (leaving the screen) throws, and leaves every record as it was.
export async function checkHeldWithdrawals({
  records,
  api,
  refresh,
  include = () => true,
  signal,
  now,
  sleep,
  pollMs,
}: CheckInput): Promise<HeldCheck[]> {
  const checks = await Promise.all(
    records
      .read()
      .filter(include)
      .map(async (record): Promise<HeldCheck> => {
        const amount = record.amount_units
        if (!record.request_id || !record.signature) {
          return { amount, outcome: "unknown" }
        }
        let outcome: Reconciled
        try {
          outcome = await reconcileWrap({
            record: {
              request_id: record.request_id,
              signature: record.signature,
              at: record.at,
            },
            api: { wrap: { confirm: api.unwrap.confirm } },
            signal,
            now,
            sleep,
            pollMs,
          })
        } catch {
          // Leaving the screen is not an answer; not being able to ask says nothing
          // about the transaction.
          signal?.throwIfAborted()
          outcome = "unknown"
        }
        return { amount, outcome }
      }),
  )
  const settled = new Set(
    checks.filter((c) => c.outcome !== "unknown").map((c) => c.amount),
  )
  if (settled.size > 0) {
    records.remove((record) => settled.has(record.amount_units))
    refresh()
  }
  return checks
}

// A record a check can ask about, and what tells one apart from another sent later for
// the same amount.
export const checkable = (record: HeldRecord) =>
  Boolean(record.request_id && record.signature)
export const recordKey = (record: HeldRecord) =>
  `${record.amount_units}:${record.signature}`

// The records a check will ask about, as one value: the screen looks again when it changes.
export const checkableKey = (
  records: readonly HeldRecord[],
  include: (record: HeldRecord) => boolean = () => true,
) =>
  records
    .filter((record) => checkable(record) && include(record))
    .map(recordKey)
    .join("|")

// What the person reads once a check has settled a withdrawal. One that stays unknown
// says nothing here: its amount is still held, and the held notice says why.
export function heldCheckMessage({
  amount,
  outcome,
}: HeldCheck): string | null {
  const what = `Your last withdrawal of ${formatUnits(amount)}`
  switch (outcome) {
    case "confirmed":
      return `${what} went through.`
    case "failed":
      return `${what} didn't go through, so nothing was withdrawn. You can withdraw again.`
    case "unknown":
      return null
  }
}
