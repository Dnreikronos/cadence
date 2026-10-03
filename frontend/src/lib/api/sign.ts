import { ApiError } from "./errors"
import { bytesFromBase64 } from "./base64"
import type { Prepared, Receipt } from "./schemas"

// The user's wallet. Today that is a Turnkey embedded wallet (#77); the web app
// only needs these two members.
export type Signer = {
  address: string
  // Signs the exact wire bytes and returns the signed wire bytes.
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>
}

export type SignStep = "signing" | "submitting" | "confirming"

export class UnexpectedSignerError extends Error {
  constructor() {
    super("The service asked for a signature from a key that is not yours")
    this.name = "UnexpectedSignerError"
  }
}

export class ConfirmTimeoutError extends Error {
  constructor() {
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
  sleep?: (ms: number) => Promise<void>
  // How long to keep asking while the transaction is not finalized yet.
  timeoutMs?: number
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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
    sleep = wait,
    timeoutMs = 60_000,
  }: Options,
): Promise<Receipt> {
  if (prepared.required_signers.some((key) => key !== signer.address)) {
    throw new UnexpectedSignerError()
  }

  onStep?.("signing")
  const signed = await signer.signTransaction(
    bytesFromBase64(prepared.transaction),
  )

  onStep?.("submitting")
  const signature = await submit(signed)

  onStep?.("confirming")
  let delay = 2_000
  let waited = 0
  for (;;) {
    try {
      return await confirm(signature)
    } catch (error) {
      const notYet =
        error instanceof ApiError && error.code === "transaction_not_finalized"
      if (!notYet) throw error
      if (waited >= timeoutMs) throw new ConfirmTimeoutError()
      await sleep(delay)
      waited += delay
      delay = Math.min(Math.round(delay * 1.5), 10_000)
    }
  }
}
