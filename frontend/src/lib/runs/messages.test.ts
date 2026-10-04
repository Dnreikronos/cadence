import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  describeFailure,
  failureCodeMessage,
  inviteMessage,
  runMessage,
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

describe("inviteMessage", () => {
  it("explains the 409s an invite can get", () => {
    expect(inviteMessage(new ApiError(409, "person_already_active"))).toMatch(
      /already has an account/,
    )
    expect(inviteMessage(new ApiError(409, "person_removed"))).toMatch(
      /was removed/,
    )
  })
})

describe("failureCodeMessage", () => {
  it("has a message when the service gives no code", () => {
    expect(failureCodeMessage(null)).toMatch(/didn't go through/)
  })
})

describe("describeFailure", () => {
  it("treats a confirm timeout as stalled and keeps its signature", () => {
    const failure = describeFailure(new ConfirmTimeoutError("sig-1"))
    expect(failure.stalled).toBe(true)
    expect(failure.signature).toBe("sig-1")
    // The signature is data to keep, not text to show.
    expect(failure.message).not.toContain("sig-1")
  })

  it("treats everything else as final, so a retry is offered", () => {
    for (const error of [
      new ApiError(409, "transaction_failed"),
      new WalletUnavailableError("no wallet"),
      new UnexpectedSignerError(),
      new Error("boom"),
    ]) {
      expect(describeFailure(error).stalled).toBe(false)
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
})
