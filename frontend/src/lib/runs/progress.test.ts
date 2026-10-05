import { describe, expect, it } from "vitest"
import { expiredMessage, unrecognizedMessage } from "./messages"
import {
  canRecheck,
  canRetry,
  canSignAgain,
  holdsUnconfirmed,
  isSettled,
  localReducer,
  mergeRow,
  tally,
  type LocalRows,
  type Row,
} from "./progress"

const ID = "b0000000-0000-4000-8000-000000000001"
const SIGNATURE = "5SigMockSignature1111111111111111111111111111"

function play(...actions: Parameters<typeof localReducer>[1][]) {
  return actions.reduce<LocalRows>(localReducer, {})
}

describe("localReducer", () => {
  it("walks a payment through signing, waiting and confirmed", () => {
    expect(play({ type: "signing", id: ID })[ID].status).toBe("signing")
    expect(
      play({ type: "signing", id: ID }, { type: "waiting", id: ID })[ID].status,
    ).toBe("waiting")
    expect(
      play(
        { type: "signing", id: ID },
        { type: "submitted", id: ID, signature: SIGNATURE },
        { type: "confirmed", id: ID },
      )[ID],
    ).toEqual({ status: "confirmed", signature: SIGNATURE })
  })

  it("keeps the signature once it is sent, so it can be checked again", () => {
    const state = play(
      { type: "signing", id: ID },
      { type: "submitted", id: ID, signature: SIGNATURE },
      { type: "waiting", id: ID },
    )
    expect(state[ID]).toMatchObject({ status: "waiting", signature: SIGNATURE })
  })

  it("marks a failure before anything was sent as failed, with its message", () => {
    const state = play(
      { type: "signing", id: ID },
      { type: "failed", id: ID, message: "Rejected", sent: false },
    )
    expect(state[ID]).toMatchObject({ status: "failed", message: "Rejected" })
  })

  it("keeps a sent payment waiting, with its signature, rather than failed", () => {
    const state = play(
      { type: "signing", id: ID },
      {
        type: "failed",
        id: ID,
        message: "Sent",
        sent: true,
        signature: SIGNATURE,
      },
    )
    expect(state[ID]).toEqual({
      status: "waiting",
      stalled: true,
      signature: SIGNATURE,
      message: "Sent",
    })
  })

  it("uses the signature already seen when a sent failure brings none", () => {
    const state = play(
      { type: "submitted", id: ID, signature: SIGNATURE },
      { type: "failed", id: ID, message: "Sent", sent: true },
    )
    expect(state[ID]).toMatchObject({ status: "waiting", signature: SIGNATURE })
  })

  it("marks a sent payment with no signature unknown: nothing to ask about", () => {
    const state = play(
      { type: "signing", id: ID },
      { type: "failed", id: ID, message: "Maybe sent", sent: true },
    )
    expect(state[ID]).toEqual({ status: "unknown", message: "Maybe sent" })
  })

  it("forgets the old failure when a retry starts", () => {
    const state = play(
      { type: "failed", id: ID, message: "Rejected", sent: false },
      { type: "signing", id: ID },
    )
    expect(state[ID]).toEqual({ status: "signing" })
  })

  it("clears the old message while a stalled payment is checked again", () => {
    const state = play(
      {
        type: "failed",
        id: ID,
        message: "Sent",
        sent: true,
        signature: SIGNATURE,
      },
      { type: "waiting", id: ID },
    )
    expect(state[ID]).toEqual({
      status: "waiting",
      signature: SIGNATURE,
      stalled: false,
    })
  })

  it("leaves other payments alone", () => {
    const other = "b0000000-0000-4000-8000-000000000002"
    const state = play(
      { type: "signing", id: other },
      { type: "failed", id: ID, message: "x", sent: false },
    )
    expect(state[other]).toEqual({ status: "signing" })
  })
})

describe("mergeRow", () => {
  it("shows pending for a payment nothing has touched, and for `signed`", () => {
    expect(
      mergeRow(undefined, { status: "pending", failure: null }).status,
    ).toBe("pending")
    expect(
      mergeRow(undefined, { status: "signed", failure: null }).status,
    ).toBe("pending")
    expect(mergeRow().status).toBe("pending")
  })

  it("shows what this browser is doing over an older server status", () => {
    expect(
      mergeRow({ status: "signing" }, { status: "failed", failure: "x" })
        .status,
    ).toBe("signing")
    expect(
      mergeRow({ status: "waiting" }, { status: "expired", failure: null })
        .status,
    ).toBe("waiting")
  })

  it("keeps a sent payment as sent, whatever else the server says short of confirmed", () => {
    const stalled = {
      status: "waiting" as const,
      stalled: true,
      signature: SIGNATURE,
      message: "Sent",
    }
    for (const server of ["pending", "failed", "expired"] as const) {
      expect(
        mergeRow(stalled, { status: server, failure: null }),
      ).toMatchObject({ status: "waiting", stalled: true })
    }
    expect(
      mergeRow(
        { status: "unknown", message: "Maybe sent" },
        { status: "expired", failure: null },
      ).status,
    ).toBe("unknown")
  })

  it("lets the server's `confirmed` end a waiting, stalled or unknown payment", () => {
    const server = { status: "confirmed" as const, failure: null }
    expect(mergeRow({ status: "waiting" }, server).status).toBe("confirmed")
    expect(
      mergeRow(
        { status: "waiting", stalled: true, signature: SIGNATURE },
        server,
      ),
    ).toMatchObject({ status: "confirmed", stalled: false, message: null })
    expect(mergeRow({ status: "unknown", message: "x" }, server).status).toBe(
      "confirmed",
    )
    expect(mergeRow({ status: "signing" }, server).status).toBe("confirmed")
  })

  it("never un-confirms a payment that confirmed here", () => {
    expect(
      mergeRow({ status: "confirmed" }, { status: "pending", failure: null })
        .status,
    ).toBe("confirmed")
    expect(
      mergeRow({ status: "confirmed" }, { status: "failed", failure: "x" })
        .status,
    ).toBe("confirmed")
  })

  it("shows a confirmation from the server", () => {
    expect(
      mergeRow(undefined, { status: "confirmed", failure: null }).status,
    ).toBe("confirmed")
  })

  it("lets the server's `expired` replace a failure seen here", () => {
    const row = mergeRow(
      { status: "failed", message: "Rejected" },
      { status: "expired", failure: null },
    )
    expect(row).toMatchObject({ status: "expired", message: expiredMessage })
  })

  it("says a retry of an expired payment depends on the service", () => {
    expect(expiredMessage).toMatch(/only if the service confirms/)
  })

  it("keeps a local failure while the server still says pending", () => {
    const row = mergeRow(
      { status: "failed", message: "Rejected" },
      { status: "pending", failure: null },
    )
    expect(row).toMatchObject({ status: "failed", message: "Rejected" })
  })

  it("words a server failure from its code, never from raw text", () => {
    const row = mergeRow(undefined, {
      status: "failed",
      failure: "transaction_failed",
    })
    expect(row.status).toBe("failed")
    expect(row.message).toBe(
      "The network rejected this payment. You can retry it.",
    )
  })

  it("has a plain message for a failure code it does not know", () => {
    const row = mergeRow(undefined, {
      status: "failed",
      failure: "something_new",
    })
    expect(row.message).toBe("Something went wrong. Try again.")
  })
})

describe("what can be done to a row", () => {
  const row = (status: Row["status"], patch: Partial<Row> = {}): Row => ({
    status,
    message: null,
    stalled: false,
    signature: null,
    ...patch,
  })
  const all = [
    "pending",
    "signing",
    "waiting",
    "unknown",
    "cancelled",
    "unrecognized",
    "confirmed",
    "failed",
    "expired",
  ] as const

  it("allows a retry only for a payment that did not land", () => {
    expect(all.filter((status) => canRetry(row(status)))).toEqual([
      "failed",
      "expired",
    ])
  })

  it("never offers a retry for a payment that may have been sent", () => {
    expect(
      canRetry(row("waiting", { stalled: true, signature: SIGNATURE })),
    ).toBe(false)
    expect(canRetry(row("unknown"))).toBe(false)
  })

  it("offers `check again` only with a signature to ask about", () => {
    expect(
      canRecheck(row("waiting", { stalled: true, signature: SIGNATURE })),
    ).toBe(true)
    expect(canRecheck(row("unknown"))).toBe(false)
    expect(canRecheck(row("waiting", { stalled: true }))).toBe(false)
    expect(canRecheck(row("waiting", { signature: SIGNATURE }))).toBe(false)
  })

  it("settles on confirmed, failed and expired", () => {
    expect(all.filter(isSettled)).toEqual(["confirmed", "failed", "expired"])
  })

  it("counts what needs attention apart from what is still open", () => {
    expect(
      tally([
        row("confirmed"),
        row("confirmed"),
        row("failed"),
        row("expired"),
        row("waiting", { stalled: true, signature: SIGNATURE }),
        row("unknown"),
        row("pending"),
        row("signing"),
      ]),
    ).toEqual({
      total: 8,
      confirmed: 2,
      retryable: 2,
      cancelled: 0,
      unrecognized: 0,
      sent: 2,
      attention: 4,
      open: 2,
    })
  })

  it("counts a cancelled signature as needing attention, not as open or retryable", () => {
    expect(tally([row("confirmed"), row("cancelled"), row("pending")])).toEqual(
      {
        total: 3,
        confirmed: 1,
        retryable: 0,
        cancelled: 1,
        unrecognized: 0,
        sent: 0,
        attention: 1,
        open: 1,
      },
    )
  })

  it("offers `sign again` only for a cancelled signature, and never a retry with it", () => {
    expect(all.filter((status) => canSignAgain(row(status)))).toEqual([
      "cancelled",
    ])
    expect(canRetry(row("cancelled"))).toBe(false)
    expect(canRecheck(row("cancelled"))).toBe(false)
    expect(isSettled("cancelled")).toBe(false)
  })
})

describe("a cancelled signature", () => {
  const message = "You cancelled the signature. Nothing was sent."
  const cancelled = play(
    { type: "signing", id: ID },
    { type: "failed", id: ID, message, sent: false, cancelled: true },
  )

  it("is its own row, not a failure", () => {
    expect(cancelled[ID]).toEqual({ status: "cancelled", message })
    expect(
      mergeRow(cancelled[ID], { status: "pending", failure: null }),
    ).toEqual({ status: "cancelled", message, stalled: false, signature: null })
  })

  it("is an ordinary failure when it was not a refusal", () => {
    const failed = play({
      type: "failed",
      id: ID,
      message: "x",
      sent: false,
      cancelled: false,
    })
    expect(failed[ID].status).toBe("failed")
  })

  it("never turns a payment that may have been sent into one that can be signed again", () => {
    const sent = play(
      { type: "submitted", id: ID, signature: SIGNATURE },
      { type: "failed", id: ID, message: "x", sent: true, cancelled: true },
    )
    expect(sent[ID].status).toBe("waiting")
    expect(sent[ID].stalled).toBe(true)
  })

  it("gives way to the server's final answer, and to a confirmation", () => {
    expect(
      mergeRow(cancelled[ID], { status: "confirmed", failure: null }).status,
    ).toBe("confirmed")
    expect(
      mergeRow(cancelled[ID], { status: "expired", failure: null }).status,
    ).toBe("expired")
    const failed = mergeRow(cancelled[ID], {
      status: "failed",
      failure: "transaction_failed",
    })
    expect(failed.status).toBe("failed")
    // The cancelled text is not carried over to a payment that did fail.
    expect(failed.message).not.toBe(message)
    // Anything else the server says leaves it cancelled.
    expect(
      mergeRow(cancelled[ID], { status: "signed", failure: null }).status,
    ).toBe("cancelled")
  })

  it("keeps the leave guard up, because the held transaction dies with the page", () => {
    expect(holdsUnconfirmed(cancelled)).toBe(true)
  })

  it("is signing again from the moment it is tried, and confirmed when it lands", () => {
    const again = localReducer(cancelled, { type: "signing", id: ID })
    expect(again[ID]).toEqual({ status: "signing" })
    expect(localReducer(again, { type: "confirmed", id: ID })[ID].status).toBe(
      "confirmed",
    )
  })
})

describe("an unknown status from the service", () => {
  const unknown = { status: "finalized", failure: null }

  it("is its own row, not pending, and says the status is unknown", () => {
    expect(mergeRow(undefined, unknown)).toEqual({
      status: "unrecognized",
      message: unrecognizedMessage,
      stalled: false,
      signature: null,
    })
    expect(
      mergeRow(undefined, { status: "Confirmed", failure: null }).status,
    ).toBe("unrecognized")
    expect(unrecognizedMessage).toMatch(/Status unknown/)
  })

  it("offers nothing: no retry, no sign again, no check, and it is not pending", () => {
    const row = mergeRow(undefined, { status: "reversed", failure: "x" })
    expect(canRetry(row)).toBe(false)
    expect(canSignAgain(row)).toBe(false)
    expect(canRecheck(row)).toBe(false)
    expect(row.status).not.toBe("confirmed")
    expect(row.status).not.toBe("pending")
  })

  it("is not settled, and needs attention rather than counting as open", () => {
    expect(isSettled("unrecognized")).toBe(false)
    expect(
      tally([
        mergeRow(undefined, unknown),
        mergeRow(undefined, { status: "pending", failure: null }),
      ]),
    ).toMatchObject({ unrecognized: 1, attention: 1, open: 1, retryable: 0 })
  })

  it("beats a cancelled signature and a failure seen here, since it may be in flight", () => {
    const cancelled = play({
      type: "failed",
      id: ID,
      message: "x",
      sent: false,
      cancelled: true,
    })
    expect(mergeRow(cancelled[ID], unknown).status).toBe("unrecognized")
    expect(mergeRow({ status: "failed", message: "x" }, unknown).status).toBe(
      "unrecognized",
    )
  })

  it("does not overwrite what this browser is doing or has seen confirmed", () => {
    expect(mergeRow({ status: "signing" }, unknown).status).toBe("signing")
    expect(mergeRow({ status: "confirmed" }, unknown).status).toBe("confirmed")
    expect(
      mergeRow(
        { status: "waiting", stalled: true, signature: SIGNATURE },
        unknown,
      ),
    ).toMatchObject({ status: "waiting", stalled: true })
  })

  it("leaves `signed` as the pending it has always been", () => {
    expect(
      mergeRow(undefined, { status: "signed", failure: null }).status,
    ).toBe("pending")
  })
})
