import { describe, expect, it } from "vitest"
import { expiredMessage } from "./messages"
import {
  canRetry,
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

  it("marks a failure as failed, with its message", () => {
    const state = play(
      { type: "signing", id: ID },
      { type: "failed", id: ID, message: "Rejected", stalled: false },
    )
    expect(state[ID]).toMatchObject({ status: "failed", message: "Rejected" })
  })

  it("keeps a stalled payment waiting rather than failed", () => {
    const state = play(
      { type: "signing", id: ID },
      {
        type: "failed",
        id: ID,
        message: "Slow",
        stalled: true,
        signature: SIGNATURE,
      },
    )
    expect(state[ID]).toEqual({
      status: "waiting",
      message: "Slow",
      stalled: true,
      signature: SIGNATURE,
    })
  })

  it("forgets the old failure when a retry starts", () => {
    const state = play(
      { type: "failed", id: ID, message: "Rejected", stalled: false },
      { type: "signing", id: ID },
    )
    expect(state[ID]).toEqual({ status: "signing" })
  })

  it("leaves other payments alone", () => {
    const other = "b0000000-0000-4000-8000-000000000002"
    const state = play(
      { type: "signing", id: other },
      { type: "failed", id: ID, message: "x", stalled: false },
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

  it("never un-confirms a payment that confirmed here", () => {
    expect(
      mergeRow({ status: "confirmed" }, { status: "pending", failure: null })
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

  it("flags a stalled payment and carries its signature", () => {
    const row = mergeRow(
      {
        status: "waiting",
        stalled: true,
        signature: SIGNATURE,
        message: "Slow",
      },
      { status: "pending", failure: null },
    )
    expect(row).toMatchObject({
      status: "waiting",
      stalled: true,
      signature: SIGNATURE,
    })
  })
})

describe("retry and tally", () => {
  const row = (status: Row["status"]): Row => ({
    status,
    message: null,
    stalled: false,
    signature: null,
  })

  it("allows a retry only for a payment that did not land", () => {
    expect(
      (
        [
          "pending",
          "signing",
          "waiting",
          "confirmed",
          "failed",
          "expired",
        ] as const
      ).filter((status) => canRetry(row(status))),
    ).toEqual(["failed", "expired"])
  })

  it("settles on confirmed, failed and expired", () => {
    expect(
      (
        [
          "pending",
          "signing",
          "waiting",
          "confirmed",
          "failed",
          "expired",
        ] as const
      ).filter(isSettled),
    ).toEqual(["confirmed", "failed", "expired"])
  })

  it("counts expired as needing attention and everything else unsettled as open", () => {
    expect(
      tally(
        (
          [
            "confirmed",
            "confirmed",
            "failed",
            "expired",
            "pending",
            "signing",
          ] as const
        ).map(row),
      ),
    ).toEqual({ total: 6, confirmed: 2, failed: 2, open: 2 })
  })
})
