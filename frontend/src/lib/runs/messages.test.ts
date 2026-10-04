import { describe, expect, it } from "vitest"
import { ApiError, ContractError } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  ResponseMismatchError,
  SentPaymentError,
  isSignatureRejection,
} from "./errors"
import {
  describeFailure,
  failureCodeMessage,
  runMessage,
  sentWithSignatureMessage,
  sentWithoutSignatureMessage,
} from "./messages"

describe("runMessage", () => {
  it("words the run-specific codes", () => {
    expect(runMessage(new ApiError(409, "recipient_not_activated"))).toMatch(
      /hasn't set up their account/,
    )
    expect(runMessage(new ApiError(404, "run_not_found"))).toMatch(
      /payroll run/,
    )
    expect(runMessage(new ApiError(409, "payment_not_retryable"))).toMatch(
      /can't be retried/,
    )
  })

  it("says a changed balance is fixed by retrying, not by depositing", () => {
    // Payments 2..N are built before payment 1 lands, so they can find the balance
    // changed while there is plenty of money.
    const message = runMessage(new ApiError(409, "invalid_confidential_state"))
    expect(message).toBe(
      "The balance changed while signing. Retry this payment.",
    )
    expect(message).not.toMatch(/deposit/i)
  })

  it("falls back to the shared catalog, then to a plain sentence", () => {
    expect(runMessage(new ApiError(0, "network_error"))).toBe(
      "Can't reach Cadence. Check your connection.",
    )
    expect(runMessage(new ApiError(400, "made_up_code"))).toBe(
      "Something went wrong. Try again.",
    )
    expect(runMessage(new Error("raw detail 4200000000"))).toBe(
      "Something went wrong. Try again.",
    )
  })

  it("never echoes the code or a raw message", () => {
    const shown = runMessage(new ApiError(500, "secret_internal_code"))
    expect(shown).not.toContain("secret_internal_code")
  })
})

describe("failureCodeMessage", () => {
  it("has a message when the service gives no code", () => {
    expect(failureCodeMessage(null)).toMatch(/didn't go through/)
  })
})

describe("describeFailure", () => {
  it("treats a payment that may have been sent as sent, and keeps its signature", () => {
    const failure = describeFailure(
      new SentPaymentError(new ApiError(500, "internal_error"), "sig-1"),
    )
    expect(failure).toEqual({
      message: sentWithSignatureMessage,
      sent: true,
      signature: "sig-1",
    })
    // The signature is data to keep, not text to show.
    expect(failure.message).not.toContain("sig-1")
  })

  it("says to look at the payments and balance when there is no signature", () => {
    const failure = describeFailure(new SentPaymentError(new Error("x"), null))
    expect(failure).toEqual({
      message: sentWithoutSignatureMessage,
      sent: true,
    })
    expect(failure.message).toMatch(/company payments and balance/)
  })

  it("finds the signature on a confirm timeout, wrapped or not", () => {
    const timeout = new ConfirmTimeoutError("sig-2")
    expect(describeFailure(timeout)).toMatchObject({
      sent: true,
      signature: "sig-2",
    })
    expect(describeFailure(new SentPaymentError(timeout, null))).toMatchObject({
      sent: true,
      signature: "sig-2",
    })
  })

  it("treats failures before anything was sent as final, so a retry is offered", () => {
    for (const error of [
      new ApiError(409, "transaction_failed"),
      new WalletUnavailableError("no wallet"),
      new UnexpectedSignerError(),
      new ResponseMismatchError(),
      new ApiError(500, "internal_error"),
      new ContractError("/runs", "drift"),
    ]) {
      expect(describeFailure(error).sent).toBe(false)
    }
  })

  it("says plainly when signing is unavailable, without the internal reason", () => {
    const { message } = describeFailure(
      new WalletUnavailableError(
        "the embedded wallet is not integrated yet (#78)",
      ),
    )
    expect(message).toBe("Signing isn't available in this environment yet.")
    expect(message).not.toContain("#78")
  })

  it("tells a cancelled signature from a failure: nothing was sent", () => {
    const cancelled = Object.assign(new Error("denied"), {
      name: "UserRejectedRequestError",
    })
    expect(describeFailure(cancelled)).toEqual({
      message: "You cancelled the signature. Nothing was sent.",
      sent: false,
    })
  })
})

describe("isSignatureRejection", () => {
  it("knows how wallets and passkeys report a refusal", () => {
    expect(
      isSignatureRejection(Object.assign(new Error(), { code: 4001 })),
    ).toBe(true)
    expect(
      isSignatureRejection(
        Object.assign(new Error(), { name: "NotAllowedError" }),
      ),
    ).toBe(true)
    expect(isSignatureRejection(new Error("boom"))).toBe(false)
    expect(isSignatureRejection("nope")).toBe(false)
  })
})
