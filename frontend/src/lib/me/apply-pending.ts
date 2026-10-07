import type { ApiClient } from "@/lib/api/client"
import { ApiError, messageFor } from "@/lib/api/errors"
import type { Receipt } from "@/lib/api/schemas"
import { otherTabMessage } from "@/lib/flow-lock"
import {
  ConfirmTimeoutError,
  UnexpectedSignerError,
  UnexpectedTransactionError,
  type SignStep,
} from "@/lib/api/sign"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import type { Submission } from "@/lib/submissions"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError, type Wallet } from "@/lib/wallet/types"

// The kind under which the apply in flight is kept in the submissions store.
export const APPLY_KIND = "apply-pending"

export type ApplyPhase = "preparing" | SignStep

export type ApplyStore = {
  read: () => Submission | null
  record: (record: Omit<Submission, "at"> & { at?: number }) => Submission
  clear: () => void
}

export type ApplyPendingDeps = {
  accounts: Pick<ApiClient["accounts"], "applyPending" | "confirmApplyPending">
  wallet: Wallet
  run: ReturnType<typeof bindSignAndConfirm>
  store: ApplyStore
  // Throws when a record of the send cannot be kept and the mode forbids sending without
  // one (`requireDurable`): asked before anything is prepared, and again right after the
  // record is written, before the send.
  requireStorage?: () => void
  now?: () => number
}

// The transaction was handed to the network (or was about to be) and what became
// of it is not known, so another one must not be prepared until it is. `signature`
// is the one the network returned, or null when `submit` itself failed.
export class SentApplyError extends Error {
  constructor(
    readonly signature: string | null,
    cause: unknown,
  ) {
    super("Applying the pending balance may already have gone through", {
      cause,
    })
    this.name = "SentApplyError"
  }
}

// Another apply is running (or one sent earlier is not seen through yet).
export class ApplyInProgressError extends Error {
  constructor() {
    super("An apply is already in progress")
    this.name = "ApplyInProgressError"
  }
}

// Another tab holds the apply lock (it is applying, or looking up an apply it sent): this
// one prepared and sent nothing.
export class ApplyOtherTabError extends Error {
  constructor() {
    super(otherTabMessage("update"))
    this.name = "ApplyOtherTabError"
  }
}

// The network answered that it dropped the transaction. Anything else after the
// submit leaves the outcome unknown: the service compares the credit counter after
// the first apply, so even `credit_counter_mismatch` can mean it landed.
const lostForGood = new Set(["transaction_failed"])

// Prepare, sign and confirm the transaction that moves pending credits into the
// available balance. A failure before the submit (prepare, a wallet that cannot
// sign, a refused signature) is thrown as it came, and retrying is safe. From the
// submit on, every failure but a dropped transaction is a SentApplyError, and the
// submission stays recorded so a reload finds out what became of it.
export async function applyPending(
  {
    accounts,
    wallet,
    run,
    store,
    requireStorage,
    now = Date.now,
  }: ApplyPendingDeps,
  onPhase?: (phase: ApplyPhase) => void,
): Promise<Receipt> {
  if (wallet.status !== "ready") {
    throw new WalletUnavailableError(wallet.reason ?? "no wallet")
  }
  requireStorage?.()
  let record: Submission | null = null
  let signature: string | null = null
  let submitted = false
  try {
    onPhase?.("preparing")
    const prepared = await accounts.applyPending(wallet.address)
    const receipt = await run(
      prepared,
      (sig) =>
        accounts.confirmApplyPending({
          request_id: prepared.request_id,
          signature: sig,
        }),
      (step) => {
        // Before `submit` runs, not after it returns: a submit that throws (a
        // timeout, a dropped connection) may still have reached the network.
        if (step === "submitting") {
          record = store.record({
            kind: APPLY_KIND,
            request_id: prepared.request_id,
            signature: null,
            last_valid_block_height: prepared.last_valid_block_height,
            wallet: wallet.address,
            at: now(),
          })
          // Before `submitted` is set: a record that cannot be kept stops it, unsent.
          requireStorage?.()
          submitted = true
        }
        onPhase?.(step)
      },
      {
        onSubmitted: (sig) => {
          signature = sig
          if (record) record = store.record({ ...record, signature: sig })
        },
      },
    )
    store.clear()
    return receipt
  } catch (error) {
    const lost = error instanceof ApiError && lostForGood.has(error.code)
    if (!submitted || lost) {
      store.clear()
      throw error
    }
    throw new SentApplyError(signature, error)
  }
}

export function isSentFailure(error: unknown): error is SentApplyError {
  return error instanceof SentApplyError
}

// What the person reads after a sent failure. It never says "try again".
export const sentMessage =
  "This update may already have gone through, so we won't send another one yet. Check your balance."

// Never the raw message: errors can carry request details.
export function applyPendingMessage(error: unknown): string {
  if (error instanceof SentApplyError) return sentMessage
  if (error instanceof StorageUnavailableError) return storageBlockedMessage
  if (error instanceof ApplyOtherTabError) return otherTabMessage("update")
  if (error instanceof ApplyInProgressError) {
    return "An update is already in progress. Wait for it to finish."
  }
  if (error instanceof WalletUnavailableError) {
    return "Your wallet can't sign here yet."
  }
  if (error instanceof ConfirmTimeoutError) return sentMessage
  if (error instanceof UnexpectedSignerError) {
    return "That transaction wasn't prepared for your wallet. Try again."
  }
  if (error instanceof UnexpectedTransactionError) {
    return "That transaction does more than apply your balance, so it wasn't signed. Try again."
  }
  if (error instanceof ApiError) return messageFor(error)
  return "Couldn't apply your pending balance. Try again."
}
