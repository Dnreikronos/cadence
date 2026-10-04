import { ApiError } from "@/lib/api/errors"

// A failure after the transaction may have reached the network, whatever its cause: a
// timeout, a confirm that answered 500 or garbage, a submit that threw after the
// broadcast. The payment may have gone out, so a new transaction for it could pay the
// person twice. With a signature it can only be asked about again; without one nothing
// can be done from here but look at the company's payments and balance.
export class SentPaymentError extends Error {
  constructor(
    readonly original: unknown,
    readonly signature: string | null,
  ) {
    super("The payment may already have been sent")
    this.name = "SentPaymentError"
  }
}

// The service answered for a different payment or person than the one asked about.
export class ResponseMismatchError extends Error {
  constructor() {
    super("The service answered for something that was not asked")
    this.name = "ResponseMismatchError"
  }
}

// The network ran the transaction and refused it: it did not land, nothing moved.
export function rejectedByNetwork(error: unknown) {
  return error instanceof ApiError && error.code === "transaction_failed"
}

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
