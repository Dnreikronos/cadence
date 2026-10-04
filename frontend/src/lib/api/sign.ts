import { ApiError } from "./errors"
import { bytesFromBase64 } from "./base64"
import type { Prepared, Receipt } from "./schemas"

// The user's wallet. Today that is a Turnkey embedded wallet (#77); the web app
// only needs these two members.
export type Signer = {
  address: string
  // Signs the exact wire bytes and returns the signed wire bytes.
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>
  // Signs a message and returns the 64-byte ed25519 signature. Activation uses it
  // for the key-derivation message; a wallet that cannot sign messages omits it.
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
}

export type SignStep = "signing" | "submitting" | "confirming"

export class UnexpectedSignerError extends Error {
  constructor() {
    super("The service asked for a signature from a key that is not yours")
    this.name = "UnexpectedSignerError"
  }
}

export class ConfirmTimeoutError extends Error {
  // The transaction was submitted: the caller can still look it up.
  constructor(readonly signature: string) {
    super("The network did not confirm in time")
    this.name = "ConfirmTimeoutError"
  }
}

type Options = {
  signer: Signer
  // Sends the signed bytes to Solana and returns the transaction signature.
  submit: (signed: Uint8Array) => Promise<string>
  confirm: (signature: string) => Promise<Receipt>
  onStep?: (step: SignStep) => void
  // Called as soon as the transaction is on the network, so the signature is
  // never lost if confirming fails or the user leaves.
  onSubmitted?: (signature: string) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  // Stops sleeping and asking, and throws the abort reason.
  signal?: AbortSignal
  // The most wall-clock time to keep asking while the transaction is not
  // finalized yet, counted from the submit.
  timeoutMs?: number
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

// Prepare -> sign the exact bytes -> submit -> confirm, per the contract. The
// bytes are never edited, and a request for anyone else's signature is refused
// rather than answered.
export async function signAndConfirm(
  prepared: Pick<Prepared, "transaction" | "required_signers">,
  {
    signer,
    submit,
    confirm,
    onStep,
    onSubmitted,
    sleep = wait,
    now = Date.now,
    signal,
    timeoutMs = 60_000,
  }: Options,
): Promise<Receipt> {
  if (
    prepared.required_signers.length === 0 ||
    prepared.required_signers.some((key) => key !== signer.address)
  ) {
    throw new UnexpectedSignerError()
  }
  signal?.throwIfAborted()

  onStep?.("signing")
  const signed = await signer.signTransaction(
    bytesFromBase64(prepared.transaction),
  )
  signal?.throwIfAborted()

  onStep?.("submitting")
  const signature = await submit(signed)
  onSubmitted?.(signature)
  signal?.throwIfAborted()

  onStep?.("confirming")
  const deadline = now() + timeoutMs
  let delay = 2_000
  for (;;) {
    let pause = delay
    try {
      return await confirm(signature)
    } catch (error) {
      // "Not finalized yet", a busy network and a dropped connection all pass
      // with time. Anything else is final.
      if (!(error instanceof ApiError && error.isRetryable)) throw error
      if (error.retryAfter) pause = Math.max(pause, error.retryAfter * 1_000)
    }
    const remaining = deadline - now()
    if (remaining <= 0) throw new ConfirmTimeoutError(signature)
    await sleep(Math.min(pause, remaining), signal)
    signal?.throwIfAborted()
    delay = Math.min(Math.round(delay * 1.5), 10_000)
  }
}
