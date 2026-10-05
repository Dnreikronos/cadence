import type { ApiClient } from "@/lib/api/client"
import { ApiError, messageFor } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { SentApplyError } from "@/lib/me/apply-pending"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError } from "@/lib/wallet/types"
import type { MakePrivateStep } from "./types"

// Where a retry starts. "wrap" prepares a new deposit; "apply" only makes what
// is already pending available; "check" starts nothing, because a transaction
// went out and its outcome is unknown: sending another could deposit twice.
export type Resume = "wrap" | "apply" | "check"

// An apply that went out and was not seen through: what the screen needs to ask the
// service about it again without preparing anything. `signature` is null when `submit`
// itself failed, so there is nothing to ask about.
export type SentApply = { request_id: string; signature: string | null }

export class MakePrivateError extends Error {
  constructor(
    readonly step: MakePrivateStep,
    readonly resume: Resume,
    cause: unknown,
    // Set for a sent apply, whose `cause` is then a `SentApplyError`.
    readonly sent: SentApply | null = null,
  ) {
    super("Making the deposit private failed", { cause })
    this.name = "MakePrivateError"
  }
}

type Input = {
  // Start at the apply step when the wrapped amount is already pending.
  from: "wrap" | "apply"
  // Integer base units. Unused when `from` is "apply".
  amount: string
  wallet: string
  api: Pick<ApiClient, "wrap" | "accounts">
  signAndConfirm: ReturnType<typeof bindSignAndConfirm>
  signal?: AbortSignal
  onStep: (step: MakePrivateStep) => void
  // A transaction was confirmed, so balances changed. Called once per transaction.
  onConfirmed?: (which: "wrap" | "apply") => void
  // The wrap is about to be handed to the network, before `submit` runs: from
  // here it may land even if the page is closed or `submit` throws.
  onSubmitting?: (wrap: {
    request_id: string
    last_valid_block_height: number
  }) => void
  // The network returned the wrap's signature.
  onSubmitted?: (signature: string) => void
}

// The network answered that it dropped the transaction. Anything else after a
// submit leaves the deposit's fate unknown.
const lostForGood = new Set(["transaction_failed"])

// Prepare the wrap, sign it, wait for the network, then apply the pending credit
// the wrap leaves behind. A failure is a MakePrivateError that says which step
// broke and where a retry has to start, so a deposit that already landed is
// never sent twice.
export async function runMakePrivate({
  from,
  amount,
  wallet,
  api,
  signAndConfirm,
  signal,
  onStep,
  onConfirmed,
  onSubmitting,
  onSubmitted,
}: Input): Promise<void> {
  let step: MakePrivateStep = from === "wrap" ? "preparing" : "applying"
  let wrapped = from === "apply"
  let submitted = false
  // The apply step follows the same rule as `/me` (`applyPending`): once it is past
  // "signing" a failure may have gone out, and is a `SentApplyError`.
  let applyId: string | null = null
  let applyPast = false
  let applySignature: string | null = null
  try {
    if (!wrapped) {
      onStep(step)
      const prepared = await api.wrap.prepare(
        { company_wallet: wallet, amount },
        { signal },
      )
      await signAndConfirm(
        prepared,
        (signature) =>
          api.wrap.confirm(
            { request_id: prepared.request_id, signature },
            { signal },
          ),
        (signStep) => {
          // Set before `submit` runs, not after it returns: a submit that throws
          // (a timeout, a dropped connection) may still have reached the network.
          if (signStep === "submitting") {
            // The record first: one that cannot be kept stops the send, unsent.
            onSubmitting?.(prepared)
            submitted = true
          }
          // Submitting and confirming read the same to the person: "waiting".
          const next = signStep === "signing" ? "signing" : "confirming"
          if (next === step) return
          step = next
          onStep(step)
        },
        { signal, onSubmitted },
      )
      wrapped = true
      onConfirmed?.("wrap")
    }

    step = "applying"
    onStep(step)
    const prepared = await api.accounts.applyPending(wallet, { signal })
    applyId = prepared.request_id
    await signAndConfirm(
      prepared,
      (signature) =>
        api.accounts.confirmApplyPending(
          { request_id: prepared.request_id, signature },
          { signal },
        ),
      (signStep) => {
        // Before `submit` runs, not after it returns: a submit that throws may
        // still have reached the network.
        if (signStep !== "signing") applyPast = true
      },
      {
        signal,
        onSubmitted: (signature) => {
          applySignature = signature
        },
      },
    )
    onConfirmed?.("apply")
  } catch (error) {
    // The network dropping the apply is the one failure that is not a sent one.
    const dropped = error instanceof ApiError && lostForGood.has(error.code)
    // A timeout carries the signature of a transaction that was submitted.
    const timedOut = error instanceof ConfirmTimeoutError
    if (applyId && !dropped && (applyPast || timedOut)) {
      const sent = {
        request_id: applyId,
        signature:
          applySignature ??
          (timedOut ? (error as ConfirmTimeoutError).signature : null),
      }
      throw new MakePrivateError(
        step,
        "check",
        new SentApplyError(sent.signature, error),
        sent,
      )
    }
    throw new MakePrivateError(
      step,
      resumeFor(error, wrapped, submitted),
      error,
    )
  }
}

function resumeFor(
  error: unknown,
  wrapped: boolean,
  submitted: boolean,
): Resume {
  if (wrapped) {
    // A second apply cannot wrap twice, but one that went out and was not
    // confirmed may make the next one fail: look first.
    return error instanceof ConfirmTimeoutError ? "check" : "apply"
  }
  const lost = error instanceof ApiError && lostForGood.has(error.code)
  return submitted && !lost ? "check" : "wrap"
}

// What the person reads after an apply that may have gone through. It never says "try again".
export const sentApplyMessage =
  "Making your deposit available may already have gone through, so we won't send another attempt yet. Check your balances."

export function failureMessage(error: unknown): string {
  const cause = error instanceof MakePrivateError ? error.cause : error
  if (cause instanceof SentApplyError) return sentApplyMessage
  if (cause instanceof ConfirmTimeoutError) {
    return "The network hasn't confirmed this yet. Check your balances before trying again."
  }
  if (cause instanceof StorageUnavailableError) return storageBlockedMessage
  if (cause instanceof WalletUnavailableError) {
    return "Your wallet isn't available yet, so nothing can be signed."
  }
  if (cause instanceof UnexpectedSignerError) {
    return "The transaction asked for a signature from another wallet, so it wasn't signed."
  }
  return messageFor(cause)
}

export function needsSetup(error: unknown) {
  const cause = error instanceof MakePrivateError ? error.cause : error
  return (
    cause instanceof ApiError && cause.code === "confidential_setup_required"
  )
}

// Whether trying again can help. A request the service refused for what it
// holds (an amount too large, a wallet it does not know) answers the same way
// again, so the person edits the amount instead.
export function canRetry(error: unknown) {
  if (!(error instanceof MakePrivateError)) return false
  if (error.resume === "check") return false
  if (error.resume === "apply") return true
  const cause = error.cause
  if (!(cause instanceof ApiError)) return true
  return cause.isRetryable || cause.code === "transaction_failed"
}
