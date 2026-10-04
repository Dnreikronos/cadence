import {
  ApiError,
  ContractError,
  isApiError,
  messageFor,
} from "@/lib/api/errors"
import type {
  ConfirmRequest,
  Receipt,
  RevealRiskLevel,
  UnwrapPrepared,
  UnwrapRequest,
} from "@/lib/api/schemas"
import {
  ConfirmTimeoutError,
  UnexpectedSignerError,
  type SignStep,
} from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"

// ---- Running a withdrawal ---------------------------------------------------

export type WithdrawDeps = {
  prepare: (request: UnwrapRequest) => Promise<UnwrapPrepared>
  // Sign, submit and poll `confirm` until the network finalizes. `onSubmitted`
  // gets the signature the moment the transaction is on the network.
  signAndConfirm: (
    prepared: UnwrapPrepared,
    confirm: (signature: string) => Promise<Receipt>,
    onStep: (step: SignStep) => void,
    onSubmitted: (signature: string) => void,
  ) => Promise<Receipt>
  confirm: (request: ConfirmRequest) => Promise<Receipt>
}

export type WithdrawInput = {
  wallet: string
  // Integer base units.
  amount: string
  acknowledged: boolean
  onPrepared?: (level: RevealRiskLevel) => void
  onStep?: (step: SignStep) => void
}

export type WithdrawOutcome =
  // The service refused to build the transaction until the person agrees.
  | { kind: "needs-acknowledgement" }
  | { kind: "done"; level: RevealRiskLevel; receipt: Receipt }

// A failure after the transaction may have reached the network, whatever its cause
// (a timeout, an unreadable confirm, a submit that threw after the broadcast). The
// money may have moved, so nothing here is safe to run again.
export class SentWithdrawalError extends Error {
  constructor(
    readonly original: unknown,
    // Known once the network accepted it; lets the person look it up.
    readonly signature: string | null,
  ) {
    super("The withdrawal may already have been sent")
    this.name = "SentWithdrawalError"
  }
}

// Prepare first without the acknowledgement. Only a 409 `reveal_risk_not_acknowledged`
// on that first ask turns into a question for the person; an acknowledged ask that
// still gets it, and every other failure, is thrown for the caller to show.
// From the moment signing hands over to submitting, any failure is a
// `SentWithdrawalError`, except the network itself rejecting the transaction.
export async function runWithdraw(
  deps: WithdrawDeps,
  input: WithdrawInput,
): Promise<WithdrawOutcome> {
  let prepared: UnwrapPrepared
  try {
    prepared = await deps.prepare({
      wallet: input.wallet,
      amount: input.amount,
      acknowledge_reveal_risk: input.acknowledged,
    })
  } catch (error) {
    if (
      !input.acknowledged &&
      isApiError(error) &&
      error.status === 409 &&
      error.code === "reveal_risk_not_acknowledged"
    ) {
      return { kind: "needs-acknowledgement" }
    }
    throw error
  }
  input.onPrepared?.(prepared.reveal_risk.level)

  let phase = "signing" as SignStep
  let signature = null as string | null
  try {
    const receipt = await deps.signAndConfirm(
      prepared,
      (sig) =>
        deps.confirm({ request_id: prepared.request_id, signature: sig }),
      (step) => {
        phase = step
        input.onStep?.(step)
      },
      (sig) => {
        signature = sig
      },
    )
    return { kind: "done", level: prepared.reveal_risk.level, receipt }
  } catch (error) {
    if (
      (phase === "submitting" || phase === "confirming") &&
      !rejected(error)
    ) {
      throw new SentWithdrawalError(
        error,
        signature ??
          (error instanceof ConfirmTimeoutError ? error.signature : null),
      )
    }
    throw error
  }
}

// The network ran the transaction and refused it: it did not land, nothing moved.
function rejected(error: unknown) {
  return error instanceof ApiError && error.code === "transaction_failed"
}

// ---- Failures ---------------------------------------------------------------

export type Failure = {
  message: string
  // Asking again is safe and may work. Never once the transaction may have been sent.
  retryable: boolean
  // The balance may have changed, or the amount is stale: ask for it again.
  refreshBalance: boolean
  // The transaction may have reached the network, so the withdrawal may have happened.
  sent: boolean
  signature: string | null
}

export const sentMessage =
  "This withdrawal may already have gone through. Check your balance and history before trying again."

const cancelledNames = new Set([
  "SignatureRejectedError",
  "UserRejectedRequestError",
  // What a cancelled passkey prompt throws.
  "NotAllowedError",
])

// A person turning the signature down, as a wallet or a passkey prompt reports it.
export function isSignatureRejection(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return cancelledNames.has(error.name) || code === 4001
}

export function failureOf(error: unknown): Failure {
  const base = { refreshBalance: false, sent: false, signature: null }
  if (
    error instanceof SentWithdrawalError ||
    error instanceof ConfirmTimeoutError
  ) {
    return {
      ...base,
      message: sentMessage,
      retryable: false,
      refreshBalance: true,
      sent: true,
      signature: error.signature,
    }
  }
  if (error instanceof ContractError) {
    return {
      ...base,
      message: "Cadence sent an answer this app can't read.",
      retryable: false,
    }
  }
  if (error instanceof WalletUnavailableError) {
    return {
      ...base,
      message: "Your wallet isn't available to sign right now.",
      retryable: false,
    }
  }
  if (error instanceof UnexpectedSignerError) {
    return {
      ...base,
      message: "The withdrawal asked for a signature from a different wallet.",
      retryable: false,
    }
  }
  if (isSignatureRejection(error)) {
    return {
      ...base,
      message: "You cancelled the signature. Nothing was sent.",
      retryable: true,
    }
  }
  return {
    ...base,
    message: messageFor(error),
    // A plain Error is a dropped connection or the like; an ApiError says.
    retryable: isApiError(error) ? error.isRetryable : true,
    // Insufficient balance is `invalid_confidential_state`.
    refreshBalance:
      isApiError(error) && error.code === "invalid_confidential_state",
  }
}

// ---- Screen state -----------------------------------------------------------

export type Phase = "preparing" | SignStep

// A withdrawal that may have gone through. Asking for the same amount again could
// pay out twice, so the reducer refuses until the person has reloaded.
export type Held = { amount: string; signature: string | null }

// What a failed withdrawal leaves behind: its amount and signature if it may have gone out.
export function heldBy(
  error: unknown,
  amount: string | undefined,
): Held | null {
  const failure = failureOf(error)
  return failure.sent && amount !== undefined
    ? { amount, signature: failure.signature }
    : null
}

type Stage =
  | { stage: "form" }
  | { stage: "needs-acknowledgement"; amount: string; acknowledged: boolean }
  | {
      stage: "working"
      amount: string
      acknowledged: boolean
      phase: Phase
      level: RevealRiskLevel | null
    }
  | { stage: "done"; amount: string; level: RevealRiskLevel; signature: string }
  | {
      stage: "failed"
      amount: string
      acknowledged: boolean
      failure: Failure
    }

export type WithdrawState = Stage & { held: Held | null }

export type WithdrawEvent =
  | { type: "submit"; amount: string }
  | { type: "acknowledge"; value: boolean }
  | { type: "amount-changed" }
  | { type: "prepared"; level: RevealRiskLevel }
  | { type: "step"; step: SignStep }
  | { type: "needs-acknowledgement" }
  | { type: "succeeded"; level: RevealRiskLevel; signature: string }
  | { type: "failed"; failure: Failure }
  | { type: "reset" }
  // A withdrawal from earlier in the session turned out to be unresolved.
  | { type: "hold"; held: Held }

export const initialWithdraw: WithdrawState = { stage: "form", held: null }

// The agreement is for one amount: it is asked for again whenever the amount changes,
// and nothing is sent until the box is ticked. An amount that may already have gone
// out stays blocked, however many times the field is edited, until the page reloads.
export function withdrawReducer(
  state: WithdrawState,
  event: WithdrawEvent,
): WithdrawState {
  const { held } = state
  switch (event.type) {
    case "submit": {
      if (state.stage === "working" || state.stage === "done") return state
      if (held?.amount === event.amount) return state
      if (state.stage === "needs-acknowledgement") {
        if (!state.acknowledged || event.amount !== state.amount) return state
        return working(event.amount, true, held)
      }
      // From a failure, the same amount keeps what the person already agreed to.
      const acknowledged =
        state.stage === "failed" &&
        state.acknowledged &&
        state.amount === event.amount
      return working(event.amount, acknowledged, held)
    }
    case "acknowledge":
      return state.stage === "needs-acknowledgement"
        ? { ...state, acknowledged: event.value }
        : state
    case "amount-changed":
      return state.stage === "needs-acknowledgement" || state.stage === "failed"
        ? { stage: "form", held }
        : state
    case "prepared":
      return state.stage === "working"
        ? { ...state, level: event.level, phase: "signing" }
        : state
    case "step":
      return state.stage === "working" ? { ...state, phase: event.step } : state
    case "needs-acknowledgement":
      return state.stage === "working"
        ? {
            stage: "needs-acknowledgement",
            amount: state.amount,
            acknowledged: false,
            held,
          }
        : state
    case "succeeded":
      return state.stage === "working"
        ? {
            stage: "done",
            amount: state.amount,
            level: event.level,
            signature: event.signature,
            held,
          }
        : state
    case "failed":
      return state.stage === "working"
        ? {
            stage: "failed",
            amount: state.amount,
            acknowledged: state.acknowledged,
            // A failure that may have sent it can never be retried: no matter what the
            // failure says, `sent` wins.
            failure: event.failure.sent
              ? { ...event.failure, retryable: false }
              : event.failure,
            held: event.failure.sent
              ? { amount: state.amount, signature: event.failure.signature }
              : held,
          }
        : state
    case "reset":
      return state.stage === "done" ? { stage: "form", held } : state
    case "hold":
      return { ...state, held: event.held }
  }
}

function working(
  amount: string,
  acknowledged: boolean,
  held: Held | null,
): WithdrawState {
  return {
    stage: "working",
    amount,
    acknowledged,
    phase: "preparing",
    level: null,
    held,
  }
}

// The steps the screen lists while it works, in order.
export const phases = [
  "preparing",
  "signing",
  "submitting",
  "confirming",
] as const satisfies readonly Phase[]

export const phaseLabels: Record<Phase, string> = {
  preparing: "Preparing the withdrawal",
  signing: "Signing with your wallet",
  submitting: "Sending it to the network",
  confirming: "Waiting for the network",
}
