import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { SentApplyError } from "./apply-pending"
import { applyUi, type ApplyUiInput } from "./apply-ui"

const idle: ApplyUiInput = {
  pending: "1250000000",
  running: false,
  phase: null,
  lock: "none",
  settle: "none",
  outcome: "none",
  error: null,
  wallet: { ready: true, loading: false },
}
const ui = (patch: Partial<ApplyUiInput>) => applyUi({ ...idle, ...patch })

describe("applyUi", () => {
  it("offers Apply when something is pending and nothing is going on", () => {
    expect(ui({})).toMatchObject({
      visible: true,
      canApply: true,
      label: "Apply pending",
      status: null,
    })
  })

  it("hides everything at pending 0 when nothing is going on", () => {
    expect(ui({ pending: "0" })).toMatchObject({
      visible: false,
      canApply: false,
    })
  })

  it("shows what the check of the last update found, even with nothing pending", () => {
    expect(ui({ pending: "0", outcome: "unknown" })).toMatchObject({
      visible: true,
      canApply: false,
    })
  })

  it("never offers Apply at pending 0, even while something is shown", () => {
    for (const patch of [
      { lock: "checking" },
      { settle: "waiting" },
      { error: new Error("x") },
    ] as const) {
      expect(ui({ pending: "0", ...patch })).toMatchObject({
        visible: true,
        canApply: false,
      })
    }
  })

  it("offers Apply for a pending amount under a cent", () => {
    expect(ui({ pending: "1" })).toMatchObject({
      visible: true,
      canApply: true,
    })
  })

  it("disables Apply and names the step while it runs", () => {
    expect(ui({ running: true, phase: "signing" })).toMatchObject({
      canApply: false,
      label: "Signing…",
      status: "Signing…",
    })
    expect(ui({ running: true, phase: null }).label).toBe("Working…")
  })

  it("keeps Apply off while the last update is being checked", () => {
    expect(ui({ lock: "checking" })).toMatchObject({
      canApply: false,
      label: "Checking your last update…",
      status: "Checking your last update",
    })
    // And when the service could not be asked.
    expect(ui({ lock: "check-failed" }).canApply).toBe(false)
  })

  it("keeps Apply off while the balance catches up, and back after the wait", () => {
    expect(ui({ settle: "waiting" })).toMatchObject({
      canApply: false,
      label: "Updating your balance…",
      status: "Updating your balance",
    })
    expect(ui({ settle: "timed-out" })).toMatchObject({
      canApply: true,
      visible: true,
    })
  })

  it("offers Try again after a failure that sent nothing", () => {
    expect(
      ui({ error: new ApiError(503, "service_unavailable") }),
    ).toMatchObject({
      canApply: true,
      label: "Try again",
      retryable: true,
      sentFailure: false,
    })
  })

  it("never offers Try again after a failure that may have gone through", () => {
    const sent = new SentApplyError(
      "sig",
      new ApiError(409, "credit_counter_mismatch"),
    )
    expect(ui({ error: sent })).toMatchObject({
      canApply: false,
      label: "Apply pending",
      sentFailure: true,
      retryable: false,
    })
  })

  it("does not show a failure while a new apply runs", () => {
    expect(
      ui({ running: true, phase: "preparing", error: new Error("x") }),
    ).toMatchObject({ retryable: false, sentFailure: false })
  })

  it("waits for a wallet that is still loading, and cannot apply without one", () => {
    expect(ui({ wallet: { ready: false, loading: true } })).toMatchObject({
      canApply: false,
      label: "Preparing wallet…",
    })
    expect(ui({ wallet: { ready: false, loading: false } }).canApply).toBe(
      false,
    )
  })
})
