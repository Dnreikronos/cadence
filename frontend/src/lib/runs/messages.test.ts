import { describe, expect, it } from "vitest"
import { ApiError, ContractError } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  PaymentNotOnChainError,
  ResponseMismatchError,
  RunInputUnavailableError,
  SentPaymentError,
  isSignatureRejection,
} from "./errors"
import {
  cancelledMessage,
  describeFailure,
  failureCodeMessage,
  runMessage,
  sentWithSignatureMessage,
  sentWithoutSignatureMessage,
} from "./messages"

describe("runMessage", () => {
  it("words the run-specific codes", () => {
    expect(runMessage(new ApiError(404, "run_not_found"))).toMatch(
      /payroll run/,
    )
    expect(runMessage(new ApiError(400, "invalid_payments"))).toMatch(
      /listed twice/,
    )
    expect(
      runMessage(new ApiError(409, "transaction_history_unavailable")),
    ).toMatch(/can't tell whether this payment went through/)
    expect(runMessage(new ApiError(503, "run_storage_unavailable"))).toMatch(
      /Try again shortly/,
    )
  })

  it("says a retry refused while payments can still land is for later, the same for each code", () => {
    const later = runMessage(new ApiError(409, "outstanding_payments"))
    expect(later).toMatch(/once they have expired/)
    for (const code of [
      "original_signature_required",
      "transaction_not_finalized",
    ]) {
      expect(runMessage(new ApiError(409, code))).toBe(later)
    }
  })

  it("says a payment that could not be prepared is fixed by retrying, not by depositing", () => {
    for (const code of [
      "invalid_confidential_state",
      "proof_generation_failed",
    ]) {
      const message = runMessage(new ApiError(409, code))
      expect(message).toMatch(/Retry it/)
      expect(message).not.toMatch(/deposit/i)
    }
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
  it("treats a payment found not to be on the network as final, so a retry is offered", () => {
    expect(describeFailure(new PaymentNotOnChainError())).toEqual({
      message: failureCodeMessage(null),
      sent: false,
    })
  })

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
      message: cancelledMessage,
      sent: false,
    })
  })

  it("says a run cannot be made here when an input is not available, nothing sent", () => {
    expect(describeFailure(new RunInputUnavailableError("sender"))).toEqual({
      message: "Payroll runs aren't available in this environment yet.",
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
