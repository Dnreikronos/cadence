import { z } from "zod"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import {
  createRecordList,
  legacyViewerScopeIds,
  viewerScopeId,
  type RecordList,
  type SubmissionStorage,
  type Viewer,
} from "@/lib/submissions"
import type { RunEvents } from "./executor"
import type { Acquired } from "@/lib/flow-lock"
import { releaseUnderLock } from "@/lib/release"
import { requireDurable, type ApiMode } from "@/lib/storage-guard"
import { describeFailure } from "./messages"
import { attemptKey, type AttemptKey } from "./plan"

// What a payroll run keeps in the browser's `localStorage`, per viewer, so a reload or
// another tab cannot make a new run cover people who were already paid. Two kinds of
// record, both ids, signatures and block heights (no amount, nothing secret).

// The attempt to create a run: the idempotency key it was sent with, and a fingerprint
// of who and how much. Asking again for the same list reuses the key, so the service
// answers with the run it already made instead of making a second.
export const attemptSchema = z.object({
  idempotency_key: z.string().min(1),
  fingerprint: z.string().min(1),
  // Once the service answered.
  run_id: z.string().min(1).optional(),
  created_at: z.number().int().nonnegative(),
})
export type SavedAttempt = z.infer<typeof attemptSchema>

// A payment that reached the submit step: its transaction may be on the network. The
// signature is null between handing it over and the network returning one.
export const sentPaymentSchema = z.object({
  payment_id: z.string().min(1),
  run_id: z.string().min(1),
  person_id: z.string().min(1),
  request_id: z.string().min(1),
  signature: z.string().min(1).nullable(),
  last_valid_block_height: z.number().int().nonnegative(),
  // Epoch milliseconds when it was sent: the 90-second rule counts from here.
  at: z.number().int().nonnegative(),
})
export type SentPayment = z.infer<typeof sentPaymentSchema>

export type { Viewer }

export type RunEvidence = {
  attempts: RecordList<SavedAttempt>
  payments: RecordList<SentPayment>
}

export const ATTEMPT_KIND = "payroll-attempt"
export const PAYMENT_KIND = "payroll-payment"

// An attempt older than this is not replayed: a key kept for days could hand back a
// run whose transactions expired long ago, in place of a new one.
export const attemptMaxAgeMs = 24 * 60 * 60 * 1000

export function runEvidence(
  viewer: Viewer,
  storage?: SubmissionStorage | null,
): RunEvidence {
  const scope = viewerScopeId(viewer)
  const legacyScopes = legacyViewerScopeIds(viewer)
  const options = storage === undefined ? {} : { storage }
  return {
    attempts: createRecordList({
      kind: ATTEMPT_KIND,
      scope,
      legacyScopes,
      schema: attemptSchema,
      same: (a, b) => a.fingerprint === b.fingerprint,
      ...options,
    }),
    payments: createRecordList({
      kind: PAYMENT_KIND,
      scope,
      legacyScopes,
      schema: sentPaymentSchema,
      same: (a, b) => a.payment_id === b.payment_id,
      ...options,
    }),
  }
}

const evidence = new Map<string, RunEvidence>()

// The viewer's records for this tab, the same objects each time, so every screen sees
// the others' writes (and those of other tabs, which `createRecordList` reads from
// storage). They outlive the query cache that sign-out clears, are read by scope (the
// next person to sign in finds none of this one's), and signing out removes them from the
// browser (`clearViewerEvidence`).
export function runEvidenceFor(viewer: Viewer): RunEvidence {
  const scope = viewerScopeId(viewer)
  let found = evidence.get(scope)
  if (!found) {
    found = runEvidence(viewer)
    evidence.set(scope, found)
  }
  return found
}

// ---- Attempts ----------------------------------------------------------------

// The attempt saved for exactly this list, if it is recent enough to replay.
export function savedAttempt(
  { attempts }: RunEvidence,
  fingerprint: string,
  now: number,
): SavedAttempt | null {
  return (
    attempts
      .read()
      .find(
        (attempt) =>
          attempt.fingerprint === fingerprint &&
          now - attempt.created_at <= attemptMaxAgeMs,
      ) ?? null
  )
}

// The key to send for this list: the one in use on this page if it is for the same list,
// else the one saved for exactly this list (a reload, or a lost answer), else a new one.
// `saved` is what was saved, so the caller knows the service was already asked.
export function attemptFor(
  evidence: RunEvidence,
  current: AttemptKey | null,
  fingerprint: string,
  makeKey: () => string,
  now: number,
): { key: AttemptKey; saved: SavedAttempt | null } {
  const saved = savedAttempt(evidence, fingerprint, now)
  const previous =
    current?.fingerprint === fingerprint
      ? current
      : saved
        ? { fingerprint, key: saved.idempotency_key }
        : null
  return { key: attemptKey(previous, fingerprint, makeKey), saved }
}

// Written before the request goes out, so a reload during it still knows the key.
export function beginAttempt(
  { attempts }: RunEvidence,
  attempt: { idempotency_key: string; fingerprint: string },
  now: number,
) {
  const earlier = attempts
    .read()
    .find((saved) => saved.fingerprint === attempt.fingerprint)
  attempts.upsert({
    ...attempt,
    created_at:
      earlier?.idempotency_key === attempt.idempotency_key
        ? earlier.created_at
        : now,
    ...(earlier?.idempotency_key === attempt.idempotency_key && earlier.run_id
      ? { run_id: earlier.run_id }
      : {}),
  })
}

// The service answered: the run it made for the attempt.
export function attemptCreated(
  { attempts }: RunEvidence,
  fingerprint: string,
  runId: string,
) {
  const saved = attempts.read().find((a) => a.fingerprint === fingerprint)
  if (saved) attempts.upsert({ ...saved, run_id: runId })
}

// The service refused the request outright: no run exists for the key.
export function dropAttempt({ attempts }: RunEvidence, fingerprint: string) {
  attempts.remove((attempt) => attempt.fingerprint === fingerprint)
}

// Attempts with nothing left to look into go: one whose run is known and has no payment
// that may have been sent and is not settled. What its payments that were never sent
// need is a new run for them, which is a new attempt. An attempt without a run keeps
// its key, for the replay.
export function settleAttempts({ attempts, payments }: RunEvidence) {
  const open = new Set(payments.read().map((payment) => payment.run_id))
  attempts.remove(
    (attempt) => attempt.run_id !== undefined && !open.has(attempt.run_id),
  )
}

// ---- Payments ----------------------------------------------------------------

// The payment is about to be handed to the network (no signature yet).
export function paymentSending(
  { payments }: RunEvidence,
  runId: string,
  prepared: Pick<
    RunPaymentPrepared,
    "payment_id" | "person_id" | "request_id" | "last_valid_block_height"
  >,
  now: number,
  mode: ApiMode = "mock",
) {
  const stored = payments.upsert({
    payment_id: prepared.payment_id,
    run_id: runId,
    person_id: prepared.person_id,
    request_id: prepared.request_id,
    signature: null,
    last_valid_block_height: prepared.last_valid_block_height,
    at: now,
  })
  // In real mode a record that did not reach storage stops the payment before the send:
  // nothing was sent, so the in-memory copy goes too.
  if (!stored && mode === "real") {
    payments.remove((payment) => payment.payment_id === prepared.payment_id)
    requireDurable(mode, false)
  }
}

// The network returned the signature.
export function paymentSubmitted(
  { payments }: RunEvidence,
  paymentId: string,
  signature: string,
) {
  const saved = payments.read().find((p) => p.payment_id === paymentId)
  if (saved) payments.upsert({ ...saved, signature })
}

// The outcome is final (it landed, or the network refused it): the record goes, and an
// attempt whose last open payment this was goes with it.
export function paymentResolved(evidence: RunEvidence, paymentId: string) {
  evidence.payments.remove((payment) => payment.payment_id === paymentId)
  settleAttempts(evidence)
}

// A run's events, with the records kept as they happen: written before the send (no
// signature), completed with the signature, and dropped once the outcome is final: it
// landed, or it failed before anything may have been sent or the network refused it.
// A payment that may have been sent and failed to confirm keeps its record, to be asked
// about again.
export function recordEvidence(
  events: RunEvents,
  evidence: RunEvidence,
  runId: string,
  now: () => number = Date.now,
  mode: ApiMode = "mock",
): RunEvents {
  return {
    ...events,
    sending: (prepared) => {
      paymentSending(evidence, runId, prepared, now(), mode)
      events.sending?.(prepared)
    },
    submitted: (id, signature) => {
      paymentSubmitted(evidence, id, signature)
      events.submitted(id, signature)
    },
    confirmed: (id) => {
      paymentResolved(evidence, id)
      events.confirmed(id)
    },
    failed: (id, error) => {
      if (!describeFailure(error).sent) paymentResolved(evidence, id)
      events.failed(id, error)
    },
  }
}

// Whether a run came back that this browser had already been given, or one with payments
// that may have been sent: it is shown, never signed again. Payments of it that were never
// sent are not paid, and a new run is for them.
export const runSeenBefore = (
  { payments }: RunEvidence,
  saved: SavedAttempt | null,
  runId: string,
) =>
  saved?.run_id !== undefined ||
  payments.read().some((payment) => payment.run_id === runId)

// ---- Releasing a hold on purpose ---------------------------------------------

// How long a payment must have been unsettled before the person can be offered to let its
// person go: the same two minutes as a withdrawal.
export const releaseAfterMs = 2 * 60_000

export const releaseWarning =
  "The earlier payment may still have been sent. Releasing this person lets them be paid again in a new run, and if the first payment did go through they would be paid twice. Release them only after checking the company's payments and balance."

// Offered when the person's payment has been unsettled for two minutes and either cannot
// be asked about (no signature) or a lookup came back unknown (`lookedUp`).
export const canReleasePayment = (
  payment: SentPayment,
  { now, lookedUp }: { now: number; lookedUp: boolean },
) => now - payment.at >= releaseAfterMs && (!payment.signature || lookedUp)

// The person's decision: the payments kept for them go, and an attempt left with nothing
// open goes with them. Nothing about it is written anywhere.
export function releasePerson(evidence: RunEvidence, personId: string) {
  evidence.payments.remove((payment) => payment.person_id === personId)
  settleAttempts(evidence)
}

const samePayment = (a: SentPayment, b: SentPayment) =>
  a.payment_id === b.payment_id &&
  a.request_id === b.request_id &&
  a.signature === b.signature &&
  a.at === b.at

// The person's decision, on the payments they saw for that person: made under the run
// lock, only if exactly those are still what is saved and each is two minutes old, and
// clearing only them (an attempt left with nothing open goes with them).
export async function releasePersonChecked({
  evidence,
  personId,
  seen,
  lock,
  now,
}: {
  evidence: RunEvidence
  personId: string
  seen: readonly SentPayment[]
  lock: () => Promise<Acquired>
  now?: number
}) {
  const outcome = await releaseUnderLock<SentPayment>({
    lock,
    now,
    read: () =>
      evidence.payments
        .read()
        .filter((payment) => payment.person_id === personId),
    seen,
    same: samePayment,
    remove: (found) =>
      evidence.payments.remove((payment) =>
        found.some((one) => samePayment(one, payment)),
      ),
  })
  if (outcome === "released") settleAttempts(evidence)
  return outcome
}

export const unreadableMessage =
  "Unreadable saved state: some saved payments could not be read, so no run can be started until you have checked the company's payments and released them."

export const unsettledMessage =
  "Someone in this run has a payment that may have been sent and is not settled yet, perhaps from another tab. Nothing was created: check who is ticked and try again."

// Whose payment may have been sent and is not settled: they are not payable until it is.
export const unsettledPeople = (
  payments: readonly SentPayment[],
): ReadonlySet<string> => new Set(payments.map((payment) => payment.person_id))

// What stops a run to `recipients` from being created, from what is saved right now: saved
// state that cannot be read, or a payment that may have been sent to someone in it. Asked
// again once the run lock is held, because another tab may have sent a payment (or left
// state this one cannot read) since the list was chosen.
export function runBlocker(
  { payments }: Pick<RunEvidence, "payments">,
  recipients: readonly { id: string }[],
): string | null {
  if (payments.unreadable()) return unreadableMessage
  const open = unsettledPeople(payments.read())
  return recipients.some((person) => open.has(person.id))
    ? unsettledMessage
    : null
}
