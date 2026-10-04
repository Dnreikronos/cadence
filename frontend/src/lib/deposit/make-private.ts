import type { ApiClient } from "@/lib/api/client"
import { ApiError, messageFor } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError } from "@/lib/wallet/types"
import type { MakePrivateStep } from "./types"

// Where a retry starts. "wrap" prepares a new deposit; "apply" only makes what
// is already pending available; "check" starts nothing, because a transaction
// went out and its outcome is unknown: sending another could deposit twice.
export type Resume = "wrap" | "apply" | "check"

export class MakePrivateError extends Error {
  constructor(
    readonly step: MakePrivateStep,
    readonly resume: Resume,
    cause: unknown,
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
            submitted = true
            onSubmitting?.(prepared)
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
    await signAndConfirm(
      prepared,
      (signature) =>
        api.accounts.confirmApplyPending(
          { request_id: prepared.request_id, signature },
          { signal },
        ),
      undefined,
      { signal },
    )
    onConfirmed?.("apply")
  } catch (error) {
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

export function failureMessage(error: unknown): string {
  const cause = error instanceof MakePrivateError ? error.cause : error
  if (cause instanceof ConfirmTimeoutError) {
    return "The network hasn't confirmed this yet. Check your balances before trying again."
  }
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
