import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { isApiError, messageFor } from "@/lib/api/errors"
import type {
  ConfirmRequest,
  Receipt,
  RevealRiskLevel,
  UnwrapPrepared,
  UnwrapRequest,
} from "@/lib/api/schemas"
import type { SignStep } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"

// ---- Running a withdrawal ---------------------------------------------------

export type WithdrawDeps = {
  prepare: (request: UnwrapRequest) => Promise<UnwrapPrepared>
  // Sign, submit and poll `confirm` until the network finalizes.
  signAndConfirm: (
    prepared: UnwrapPrepared,
    confirm: (signature: string) => Promise<Receipt>,
    onStep: (step: SignStep) => void,
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

// Prepare first without the acknowledgement. Only a 409 `reveal_risk_not_acknowledged`
// on that first ask turns into a question for the person; an acknowledged ask that
// still gets it, and every other failure, is thrown for the caller to show.
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
  const receipt = await deps.signAndConfirm(
    prepared,
    (signature) => deps.confirm({ request_id: prepared.request_id, signature }),
    (step) => input.onStep?.(step),
  )
  return { kind: "done", level: prepared.reveal_risk.level, receipt }
}

// ---- Failures ---------------------------------------------------------------

export type Failure = {
  message: string
  // Asking again is safe and may work. Never after the transaction was sent.
  retryable: boolean
  // The balance may have changed, or the amount is stale: ask for it again.
  refreshBalance: boolean
}

export function failureOf(error: unknown): Failure {
  if (error instanceof ConfirmTimeoutError) {
    // Withdrawing again could pay out twice, so this is never offered as a retry.
    return {
      message:
        "The network hasn't confirmed your withdrawal yet. Check your balance and history before trying again.",
      retryable: false,
      refreshBalance: true,
    }
  }
  if (error instanceof WalletUnavailableError) {
    return {
      message: "Your wallet isn't available to sign right now.",
      retryable: false,
      refreshBalance: false,
    }
  }
  if (error instanceof UnexpectedSignerError) {
    return {
      message: "The withdrawal asked for a signature from a different wallet.",
      retryable: false,
      refreshBalance: false,
    }
  }
  return {
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

export type WithdrawState =
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

export const initialWithdraw: WithdrawState = { stage: "form" }

// The agreement is for one amount: it is asked for again whenever the amount changes,
// and nothing is sent until the box is ticked.
export function withdrawReducer(
  state: WithdrawState,
  event: WithdrawEvent,
): WithdrawState {
  switch (event.type) {
    case "submit": {
      if (state.stage === "working" || state.stage === "done") return state
      if (state.stage === "needs-acknowledgement") {
        if (!state.acknowledged || event.amount !== state.amount) return state
        return working(event.amount, true)
      }
      // From a failure, the same amount keeps what the person already agreed to.
      const acknowledged =
        state.stage === "failed" &&
        state.acknowledged &&
        state.amount === event.amount
      return working(event.amount, acknowledged)
    }
    case "acknowledge":
      return state.stage === "needs-acknowledgement"
        ? { ...state, acknowledged: event.value }
        : state
    case "amount-changed":
      return state.stage === "needs-acknowledgement" || state.stage === "failed"
        ? initialWithdraw
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
          }
        : state
    case "succeeded":
      return state.stage === "working"
        ? {
            stage: "done",
            amount: state.amount,
            level: event.level,
            signature: event.signature,
          }
        : state
    case "failed":
      return state.stage === "working"
        ? {
            stage: "failed",
            amount: state.amount,
            acknowledged: state.acknowledged,
            failure: event.failure,
          }
        : state
    case "reset":
      return state.stage === "done" ? initialWithdraw : state
  }
}

function working(amount: string, acknowledged: boolean): WithdrawState {
  return {
    stage: "working",
    amount,
    acknowledged,
    phase: "preparing",
    level: null,
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
