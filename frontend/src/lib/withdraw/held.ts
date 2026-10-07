import { z } from "zod"
import type { ApiClient } from "@/lib/api/client"
import { reconcileWrap, wait, type Reconciled } from "@/lib/deposit/reconcile"
import { formatUnits } from "@/lib/money"
import {
  createRecordList,
  legacyViewerScopeIds,
  viewerScopeId,
  type RecordList,
  type SubmissionStorage,
  type Viewer,
} from "@/lib/submissions"
import { releaseUnderLock, releaseUnreadableUnderLock } from "@/lib/release"
import type { Acquired } from "@/lib/flow-lock"
import type { ReadBlockHeight } from "@/lib/solana/block-height"
import { requireDurable, type ApiMode } from "@/lib/storage-guard"
import type { Held } from "./flow"

// A withdrawal that may have gone through, kept so a reload, another tab or a later visit
// cannot forget it and offer the same amount again. It holds the amount, which the other
// submission records do not: this is why it is kept per viewer only, in the browser's
// `localStorage`, dropped once the outcome is known and removed when the viewer signs out.
// `request_id` and `last_valid_block_height` are there from the moment of sending;
// the signature once the network returned one. A record without a signature
// cannot be asked about: it stays until it is released (or signed out, or pruned).
export const heldRecordSchema = z.object({
  // Canonical base units: no leading zero. Anything else is not something this app
  // wrote, and is set aside as unreadable (the whole list is then held).
  amount_units: z.string().regex(/^(0|[1-9]\d{0,19})$/),
  request_id: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
  last_valid_block_height: z.number().int().nonnegative().optional(),
  // Epoch milliseconds when it was sent: the wait before a release counts from here.
  at: z.number().int().nonnegative(),
})
export type HeldRecord = z.infer<typeof heldRecordSchema>

export const WITHDRAW_KIND = "withdraw"

export type HeldRecords = RecordList<HeldRecord>

// One record per amount: the same amount is never sent twice while one is unresolved.
export function heldRecords(
  viewer: Viewer,
  storage?: SubmissionStorage | null,
): HeldRecords {
  return createRecordList({
    kind: WITHDRAW_KIND,
    scope: viewerScopeId(viewer),
    legacyScopes: legacyViewerScopeIds(viewer),
    schema: heldRecordSchema,
    same: (a, b) => a.amount_units === b.amount_units,
    ...(storage === undefined ? {} : { storage }),
  })
}

const lists = new Map<string, HeldRecords>()

// The viewer's list for this tab, the same object each time so every screen and hook
// sees one another's writes (other tabs' too: the list reads storage). It also outlives
// the query cache, which sign-out clears: the next person signing in reads their own
// scope and none of this one's.
export function heldRecordsFor(viewer: Viewer) {
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
// added, since the two minutes before a release count from the send.
//
// In real mode a record that did not reach storage stops the withdrawal before the send
// (the first call, which comes before `submit`): nothing was sent, so the in-memory copy
// is dropped and the failure says why. Once the signature comes back it is too late to
// stop anything, and the record is kept as well as it can be.
export function withdrawEvidence(
  records: HeldRecords,
  amount: string,
  now: () => number = Date.now,
  mode: ApiMode = "mock",
) {
  return {
    onSent: (evidence: SentEvidence) => {
      const earlier = records
        .read()
        .find((record) => record.amount_units === amount)
      const at =
        earlier?.request_id === evidence.request_id ? earlier.at : now()
      const stored = records.upsert(recordFor(amount, evidence, at))
      if (evidence.signature === null && !stored && mode === "real") {
        records.remove((record) => record.amount_units === amount)
        requireDurable(mode, false)
      }
    },
    onResolved: () =>
      records.remove((record) => record.amount_units === amount),
  }
}

// ---- Looking at what became of them ------------------------------------------

// What a check of one held withdrawal found.
// - confirmed: it landed. The record is gone.
// - failed: the network refused it, or it was seen missing until its blockhash ran out
//   (its last valid block height passed). Nothing moved, the record is gone and the
//   amount is free.
// - unknown: it may or may not have landed, so the amount stays held. No signature to
//   ask about, a service that could not be reached, or one that no longer has it.
export type HeldCheck = { amount: string; outcome: Reconciled }

// The wait between two asks about the same withdrawal.
export const checkPollMs = 4_000

type CheckInput = {
  records: HeldRecords
  api: { unwrap: Pick<ApiClient["unwrap"], "confirm"> }
  // Balances may have changed: a withdrawal was found confirmed or not to have landed.
  refresh: () => void
  // Only these are looked up (default: every record). The others are left as they are.
  include?: (record: HeldRecord) => boolean
  signal?: AbortSignal
  blockHeight?: ReadBlockHeight
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
  blockHeight,
  sleep,
  pollMs = checkPollMs,
}: CheckInput): Promise<HeldCheck[]> {
  // One record at a time, one confirm every few seconds overall: asking about two at once
  // would spend the service's confirm quota twice as fast.
  const checks: HeldCheck[] = []
  let asked = false
  for (const record of records.read().filter(include)) {
    const amount = record.amount_units
    if (!checkable(record)) {
      checks.push({ amount, outcome: "unknown" })
      continue
    }
    // The next record waits as long as one record waits between its own asks.
    if (asked) await (sleep ?? wait)(pollMs, signal)
    asked = true
    let outcome: Reconciled
    try {
      outcome = await reconcileWrap({
        record,
        api: { wrap: { confirm: api.unwrap.confirm } },
        signal,
        blockHeight,
        sleep,
        pollMs,
      })
    } catch {
      // Leaving the screen is not an answer; not being able to ask says nothing about
      // the transaction.
      signal?.throwIfAborted()
      outcome = "unknown"
    }
    checks.push({ amount, outcome })
  }
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
// the same amount. Without its last valid block height nothing could tell when it can no
// longer land (every record written has one; the schema only allows it to be missing).
export const checkable = (
  record: HeldRecord,
): record is HeldRecord &
  Required<
    Pick<HeldRecord, "request_id" | "signature" | "last_valid_block_height">
  > =>
  Boolean(
    record.request_id &&
    record.signature &&
    record.last_valid_block_height !== undefined,
  )
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

// ---- Releasing a hold on purpose -----------------------------------------------

// How long a withdrawal must have been unresolved before the person can be offered to let
// it go: long enough for its blockhash to have run out and for the service to have been
// asked more than once.
export const releaseAfterMs = 2 * 60_000

// What the confirmation says plainly before an amount is released.
export const releaseWarning =
  "The earlier withdrawal may still have been sent. Releasing this amount lets it be withdrawn again, and if the first one did go through you would withdraw it twice. Release it only after checking your balance and history."

// Whether to offer the release: the withdrawal has been unresolved for two minutes, and
// either nothing can be asked about it (no signature) or a lookup came back unknown.
export const canRelease = (
  record: HeldRecord,
  { now, lookedUp }: { now: number; lookedUp: boolean },
) => now - record.at >= releaseAfterMs && (!record.signature || lookedUp)

// Removes the held amount. Only for what has been checked: see `releaseHeldChecked`.
export const releaseHeld = (records: HeldRecords, amount: string) =>
  records.remove((record) => record.amount_units === amount)

const sameHeld = (a: HeldRecord, b: HeldRecord) =>
  a.amount_units === b.amount_units &&
  a.request_id === b.request_id &&
  a.signature === b.signature &&
  a.at === b.at

// The person's decision, on the record they saw: made under the withdraw lock, only if
// that very record is still what is saved and is two minutes old, and clearing only it.
// Nothing about it is written anywhere.
export const releaseHeldChecked = ({
  records,
  seen,
  lock,
  now,
}: {
  records: HeldRecords
  seen: HeldRecord
  lock: () => Promise<Acquired>
  now?: number
}) =>
  releaseUnderLock<HeldRecord>({
    lock,
    now,
    read: () =>
      records
        .read()
        .filter((record) => record.amount_units === seen.amount_units),
    seen: [seen],
    same: sameHeld,
    remove: (found) =>
      records.remove((record) => found.some((one) => sameHeld(one, record))),
  })

export const releaseUnreadableChecked = (
  records: HeldRecords,
  lock: () => Promise<Acquired>,
) => releaseUnreadableUnderLock(lock, () => records.clearUnreadable())

export const unreadableMessage =
  "Unreadable saved state: some saved withdrawals could not be read, so nothing can be withdrawn until you have checked your history and released them."
