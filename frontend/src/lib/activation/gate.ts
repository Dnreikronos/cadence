import type { AccountStatus } from "@/lib/api/schemas"
import { doneFromStatus, isActivated } from "./machine"

export type GateView = "ready" | "redirect" | "error" | "loading"

// What the /me gate shows for the status query. Fail closed on a first read that
// failed: with no status there is no way to know the account exists, and showing a
// balance for one that may not would be wrong. But React Query keeps the last good
// data when a later refetch fails, so a recipient whose status was read once is never
// locked out by a blip afterwards: `data` wins over `isError`.
export function gateView(query: {
  data?: AccountStatus
  isError: boolean
}): GateView {
  if (query.data) {
    return isActivated(doneFromStatus(query.data)) ? "ready" : "redirect"
  }
  return query.isError ? "error" : "loading"
}
