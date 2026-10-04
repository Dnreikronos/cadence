import { isSentFailure, type ApplyPhase } from "@/lib/me/apply-pending"
import type { LastApply } from "./last-apply"
import type { Settle } from "./settle"

// "checking": the apply sent earlier is being looked up. "check-failed": the service
// could not be asked, so the lock stays until the person asks again.
export type Lock = "none" | "checking" | "check-failed"

export type ApplyUiInput = {
  pending: string
  // An apply is running, in this screen or another.
  running: boolean
  phase: ApplyPhase | null
  lock: Lock
  settle: Settle
  // What the check of the last update found, which is worth showing even with
  // nothing pending: the person was told it was being checked.
  outcome: LastApply
  // The failure of the last apply, if it has not been resolved.
  error: unknown
  wallet: { ready: boolean; loading: boolean }
}

export type ApplyUi = {
  // Whether the pending area shows at all. Nothing pending and nothing going on: no.
  visible: boolean
  canApply: boolean
  label: string
  // What a live region announces while something is going on, else null.
  status: string | null
  // The last apply may have gone through: no retry, only checking.
  sentFailure: boolean
  // A failure before anything was sent: trying again is safe.
  retryable: boolean
}

const phaseLabels: Record<ApplyPhase, string> = {
  preparing: "Preparing…",
  signing: "Signing…",
  submitting: "Sending…",
  confirming: "Confirming…",
}

export function applyUi(input: ApplyUiInput): ApplyUi {
  const { pending, running, phase, lock, settle, outcome, error, wallet } =
    input
  const hasPending = BigInt(pending) > 0n
  const sentFailure = isSentFailure(error)
  const failed = error != null && !running
  const settling = settle === "waiting"

  const status = running
    ? phase
      ? phaseLabels[phase]
      : "Working…"
    : lock === "checking"
      ? "Checking your last update"
      : settling
        ? "Updating your balance"
        : null

  const busy = running || lock !== "none" || settling
  const label = running
    ? phase
      ? phaseLabels[phase]
      : "Working…"
    : lock === "checking"
      ? "Checking your last update…"
      : lock === "check-failed"
        ? "Apply pending"
        : settling
          ? "Updating your balance…"
          : wallet.loading
            ? "Preparing wallet…"
            : failed && !sentFailure
              ? "Try again"
              : "Apply pending"

  return {
    visible:
      hasPending ||
      busy ||
      failed ||
      settle === "timed-out" ||
      outcome !== "none",
    canApply: hasPending && !busy && wallet.ready && !(failed && sentFailure),
    label,
    status,
    sentFailure: failed && sentFailure,
    retryable: failed && !sentFailure,
  }
}
