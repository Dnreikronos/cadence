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
import type { Acquired } from "@/lib/flow-lock"
import { releaseUnderLock } from "@/lib/release"
import { requireDurable, type ApiMode } from "@/lib/storage-guard"
import { paymentKey, type RunEvents } from "./executor"
import { describeFailure } from "./messages"

// What a payroll run keeps in the browser's `localStorage`, per viewer, so a reload or
// another tab cannot make a new run cover people who were already paid: each payment
// that reached the submit step, until its outcome is final. Ids, signatures and block
// heights only (no amount, nothing secret).
//
// A run that was created and never signed needs no record: its transactions never left
// the page that asked for them, and cannot land without a signature.

// A payment that reached the submit step: its transaction may be on the network. The
// signature is null between handing it over and the network returning one.
export const sentPaymentSchema = z.object({
  run_id: z.string().min(1),
  position: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  request_id: z.string().min(1),
  // Who it pays: their person id, or the account when no person was known.
  person_id: z.string().min(1),
  signature: z.string().min(1).nullable(),
  last_valid_block_height: z.number().int().nonnegative(),
  // Epoch milliseconds when it was sent: the 90-second rule counts from here.
  at: z.number().int().nonnegative(),
})
export type SentPayment = z.infer<typeof sentPaymentSchema>

export type { Viewer }

export type RunEvidence = {
  payments: RecordList<SentPayment>
}

// "payroll-payment" held the records of the shape before #107's runs, keyed by payment
// id: a new kind, so those are never read as unreadable records of this one.
export const PAYMENT_KIND = "payroll-sent"

const samePosition = (
  a: Pick<SentPayment, "run_id" | "position">,
  b: Pick<SentPayment, "run_id" | "position">,
) => a.run_id === b.run_id && a.position === b.position

export function runEvidence(
  viewer: Viewer,
  storage?: SubmissionStorage | null,
): RunEvidence {
  const scope = viewerScopeId(viewer)
  const legacyScopes = legacyViewerScopeIds(viewer)
  const options = storage === undefined ? {} : { storage }
  return {
    payments: createRecordList({
      kind: PAYMENT_KIND,
      scope,
      legacyScopes,
      schema: sentPaymentSchema,
      same: samePosition,
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

// ---- Payments ----------------------------------------------------------------

// The payment is about to be handed to the network (no signature yet).
export function paymentSending(
  { payments }: RunEvidence,
  runId: string,
  prepared: Pick<
    RunPaymentPrepared,
    "position" | "attempt" | "request_id" | "last_valid_block_height"
  >,
  personId: string,
  now: number,
  mode: ApiMode = "mock",
) {
  const stored = payments.upsert({
    run_id: runId,
    position: prepared.position,
    attempt: prepared.attempt,
    request_id: prepared.request_id,
    person_id: personId,
    signature: null,
    last_valid_block_height: prepared.last_valid_block_height,
    at: now,
  })
  // In real mode a record that did not reach storage stops the payment before the send:
  // nothing was sent, so the in-memory copy goes too.
  if (!stored && mode === "real") {
    payments.remove((payment) =>
      samePosition(payment, { run_id: runId, position: prepared.position }),
    )
    requireDurable(mode, false)
  }
}

// The saved record of a payment, by its `paymentKey`.
const byKey = (key: string) => (payment: SentPayment) =>
  paymentKey(payment.run_id, payment.position) === key

// The network returned the signature.
export function paymentSubmitted(
  { payments }: RunEvidence,
  key: string,
  signature: string,
) {
  const saved = payments.read().find(byKey(key))
  if (saved) payments.upsert({ ...saved, signature })
}

// The outcome is final (it landed, or the network refused it): the record goes.
export function paymentResolved(evidence: RunEvidence, key: string) {
  evidence.payments.remove(byKey(key))
}

// A run's events, with the records kept as they happen: written before the send (no
// signature), completed with the signature, and dropped once the outcome is final: it
// landed, or it failed before anything may have been sent or the network refused it.
// A payment that may have been sent and failed to confirm keeps its record, to be asked
// about again. `personOf` names who a position pays.
export function recordEvidence(
  events: RunEvents,
  evidence: RunEvidence,
  runId: string,
  personOf: (position: number) => string,
  now: () => number = Date.now,
  mode: ApiMode = "mock",
): RunEvents {
  return {
    ...events,
    sending: (prepared) => {
      paymentSending(
        evidence,
        runId,
        prepared,
        personOf(prepared.position),
        now(),
        mode,
      )
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

// The person's decision: the payments kept for them go. Nothing about it is written
// anywhere.
export function releasePerson(evidence: RunEvidence, personId: string) {
  evidence.payments.remove((payment) => payment.person_id === personId)
}

const samePayment = (a: SentPayment, b: SentPayment) =>
  samePosition(a, b) &&
  a.request_id === b.request_id &&
  a.signature === b.signature &&
  a.at === b.at

// The person's decision, on the payments they saw for that person: made under the run
// lock, only if exactly those are still what is saved and each is two minutes old, and
// clearing only them.
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
