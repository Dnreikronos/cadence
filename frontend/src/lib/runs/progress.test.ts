import { describe, expect, it } from "vitest"
import {
  cancelledMessage,
  expiredMessage,
  notSentMessage,
  unrecognizedMessage,
} from "./messages"
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

const ID = "c0000000-0000-4000-8000-000000000001:0"
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
    const other = "c0000000-0000-4000-8000-000000000001:1"
    const state = play(
      { type: "signing", id: other },
      { type: "failed", id: ID, message: "x", sent: false },
    )
    expect(state[other]).toEqual({ status: "signing" })
  })
})

const server = (status: string, error: string | null = null) => ({
  status,
  error,
})

describe("mergeRow", () => {
  it("shows pending for a prepared payment this page holds, not sent for one it does not", () => {
    expect(mergeRow(undefined, server("prepared"), true).status).toBe("pending")
    expect(mergeRow(undefined, undefined, true).status).toBe("pending")
    expect(mergeRow(undefined, server("prepared"))).toEqual({
      status: "not-sent",
      message: notSentMessage,
      stalled: false,
      signature: null,
    })
    expect(mergeRow().status).toBe("not-sent")
  })

  it("says a payment that was not sent was not paid in this run, and how to pay them", () => {
    expect(notSentMessage).toMatch(/wasn't paid in this run/)
    expect(notSentMessage).toMatch(/new run/)
  })

  it("shows what this browser is doing over an older server status", () => {
    expect(mergeRow({ status: "signing" }, server("failed", "x")).status).toBe(
      "signing",
    )
    expect(mergeRow({ status: "waiting" }, server("expired")).status).toBe(
      "waiting",
    )
  })

  it("keeps a sent payment as sent, whatever else the server says short of finalized", () => {
    const stalled = {
      status: "waiting" as const,
      stalled: true,
      signature: SIGNATURE,
      message: "Sent",
    }
    for (const status of [
      "prepared",
      "failed",
      "expired",
      "preparation_failed",
    ]) {
      expect(mergeRow(stalled, server(status))).toMatchObject({
        status: "waiting",
        stalled: true,
      })
    }
    expect(
      mergeRow({ status: "unknown", message: "Maybe sent" }, server("expired"))
        .status,
    ).toBe("unknown")
  })

  it("lets the server's `finalized` end a waiting, stalled or unknown payment", () => {
    const done = server("finalized")
    expect(mergeRow({ status: "waiting" }, done).status).toBe("confirmed")
    expect(
      mergeRow(
        { status: "waiting", stalled: true, signature: SIGNATURE },
        done,
      ),
    ).toMatchObject({ status: "confirmed", stalled: false, message: null })
    expect(mergeRow({ status: "unknown", message: "x" }, done).status).toBe(
      "confirmed",
    )
    expect(mergeRow({ status: "signing" }, done).status).toBe("confirmed")
  })

  it("never un-confirms a payment that confirmed here", () => {
    expect(mergeRow({ status: "confirmed" }, server("prepared")).status).toBe(
      "confirmed",
    )
    expect(
      mergeRow({ status: "confirmed" }, server("failed", "x")).status,
    ).toBe("confirmed")
  })

  it("shows a finalized payment from the server as confirmed", () => {
    expect(mergeRow(undefined, server("finalized")).status).toBe("confirmed")
  })

  it("lets the server's `expired` replace a failure seen here", () => {
    const row = mergeRow(
      { status: "failed", message: "Rejected" },
      server("expired"),
    )
    expect(row).toMatchObject({ status: "expired", message: expiredMessage })
  })

  it("says an expired payment can be retried", () => {
    expect(expiredMessage).toMatch(/retry/)
  })

  it("keeps a local failure while the server still says prepared", () => {
    const row = mergeRow(
      { status: "failed", message: "Rejected" },
      server("prepared"),
    )
    expect(row).toMatchObject({ status: "failed", message: "Rejected" })
  })

  it("words a server failure from its code, never from raw text", () => {
    const row = mergeRow(undefined, server("failed", "transaction_failed"))
    expect(row.status).toBe("failed")
    expect(row.message).toBe(
      "The network rejected this payment. You can retry it.",
    )
  })

  it("shows a payment that could not be prepared as failed, from its code", () => {
    const row = mergeRow(
      undefined,
      server("preparation_failed", "proof_generation_failed"),
    )
    expect(row).toMatchObject({
      status: "failed",
      message: "This payment couldn't be prepared. Retry it.",
    })
    expect(canRetry(row)).toBe(true)
  })

  it("has a plain message for a failure code it does not know", () => {
    const row = mergeRow(undefined, server("failed", "something_new"))
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
    "not-sent",
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

  it("settles on not sent, confirmed, failed and expired", () => {
    expect(all.filter(isSettled)).toEqual([
      "not-sent",
      "confirmed",
      "failed",
      "expired",
    ])
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
        row("not-sent"),
        row("pending"),
        row("signing"),
      ]),
    ).toEqual({
      total: 9,
      confirmed: 2,
      retryable: 2,
      cancelled: 0,
      unrecognized: 0,
      sent: 2,
      notSent: 1,
      attention: 5,
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
        notSent: 0,
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
  const message = cancelledMessage
  const cancelled = play(
    { type: "signing", id: ID },
    { type: "failed", id: ID, message, sent: false, cancelled: true },
  )

  it("is its own row, not a failure, while this page holds its transaction", () => {
    expect(cancelled[ID]).toEqual({ status: "cancelled", message })
    expect(mergeRow(cancelled[ID], server("prepared"), true)).toEqual({
      status: "cancelled",
      message,
      stalled: false,
      signature: null,
    })
  })

  it("says nothing was sent and that signing again continues the run", () => {
    expect(message).toMatch(/Nothing was sent/)
    expect(message).toMatch(/sign again/)
  })

  it("is not sent once this page no longer holds its transaction", () => {
    expect(mergeRow(cancelled[ID], server("prepared"), false)).toMatchObject({
      status: "not-sent",
      message: notSentMessage,
    })
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
    expect(mergeRow(cancelled[ID], server("finalized"), true).status).toBe(
      "confirmed",
    )
    expect(mergeRow(cancelled[ID], server("expired"), true).status).toBe(
      "expired",
    )
    const failed = mergeRow(
      cancelled[ID],
      server("failed", "transaction_failed"),
      true,
    )
    expect(failed.status).toBe("failed")
    // The cancelled text is not carried over to a payment that did fail.
    expect(failed.message).not.toBe(message)
    expect(
      mergeRow(cancelled[ID], server("preparation_failed", "x"), true).status,
    ).toBe("failed")
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
  const unknown = server("settled")

  it("is its own row, not pending, and says the status is unknown", () => {
    expect(mergeRow(undefined, unknown)).toEqual({
      status: "unrecognized",
      message: unrecognizedMessage,
      stalled: false,
      signature: null,
    })
    expect(mergeRow(undefined, server("Finalized")).status).toBe("unrecognized")
    // The names of the shape before #107's runs are unknown too.
    expect(mergeRow(undefined, server("confirmed")).status).toBe("unrecognized")
    expect(unrecognizedMessage).toMatch(/Status unknown/)
  })

  it("offers nothing: no retry, no sign again, no check, and it is not pending", () => {
    const row = mergeRow(undefined, server("reversed", "x"), true)
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
        mergeRow(undefined, server("prepared"), true),
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
    expect(mergeRow(cancelled[ID], unknown, true).status).toBe("unrecognized")
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
})

describe("a retried payment", () => {
  it("forgets what this page saw of the old attempt", () => {
    const failed = localReducer(
      {},
      { type: "failed", id: "r:1", message: "x", sent: false },
    )
    expect(localReducer(failed, { type: "reset", id: "r:1" })).toEqual({})
    // Then it reads as the service and the held transaction say.
    expect(
      mergeRow(undefined, { status: "prepared", error: null }, true).status,
    ).toBe("pending")
  })
})
