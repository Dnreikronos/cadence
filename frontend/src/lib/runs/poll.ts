import { isKnownRunPaymentStatus } from "@/lib/api/schemas"

export const runPollMs = 5_000

// A status this app does not know is asked about a few more times, then left: it may be
// one the service never moves on from, and polling it forever costs a read every 5 s.
export const unrecognizedPollReads = 6

// How long to wait before reading a run again, or false to stop. A payment that is
// pending or signed keeps the polling going, as before. Only unrecognized statuses are
// bounded, by the number of reads of this run so far.
export function runPollInterval(
  statuses: readonly string[],
  reads: number,
): number | false {
  const inFlight = statuses.some(
    (status) => status === "pending" || status === "signed",
  )
  if (inFlight) return runPollMs
  const unrecognized = statuses.some(
    (status) => !isKnownRunPaymentStatus(status),
  )
  return unrecognized && reads < unrecognizedPollReads ? runPollMs : false
}
