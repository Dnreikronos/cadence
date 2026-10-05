import { sumUnits } from "@/lib/money"
import type { AmountsRead } from "./amounts"
import type { PersonRecord } from "./types"

// What the screen knows about the amounts. "stale" is figures that were read
// once and whose refresh failed: still worth showing, never worth trusting.
export type AmountsView =
  | { state: "loading" }
  | { state: "error" }
  | {
      state: "ready" | "stale"
      byPerson: Record<string, string>
      truncated: boolean
    }

export function amountsView(query: {
  data: AmountsRead | undefined
  isError: boolean
}): AmountsView {
  if (query.data) {
    return {
      state: query.isError ? "stale" : "ready",
      byPerson: query.data.byPerson,
      truncated: query.data.truncated,
    }
  }
  return { state: query.isError ? "error" : "loading" }
}

// What the proof service holds for the person being edited. Unknown unless the
// amounts are fresh, so that the form then writes whatever is typed: comparing
// with a figure that may be out of date could skip a write that is needed.
export type CurrentAmount =
  { known: true; units: string | undefined } | { known: false }

export function currentAmount(
  view: AmountsView,
  refreshing: boolean,
  personId: string,
): CurrentAmount {
  if (view.state !== "ready" || refreshing) return { known: false }
  const units = view.byPerson[personId]
  // A partial read cannot say a person has no amount.
  if (units === undefined && view.truncated) return { known: false }
  return { known: true, units }
}

export type PeopleSummary = {
  // Base units, over the people shown that have an amount. Absent until read.
  total: string | undefined
  // People shown without an amount. Zero when the read was partial: unknown then.
  missing: number
}

export function summarize(
  people: readonly PersonRecord[],
  view: AmountsView,
): PeopleSummary {
  if (view.state === "loading" || view.state === "error") {
    return { total: undefined, missing: 0 }
  }
  const withAmount = people.filter((person) => person.id in view.byPerson)
  return {
    total: sumUnits(withAmount.map((person) => view.byPerson[person.id])),
    missing: view.truncated ? 0 : people.length - withAmount.length,
  }
}

// Whether an auditor can read the company's amounts, for the "who can see this"
// sentence. Unknown (still loading, failed, or a partial list with none active)
// is undefined, which makes the sentence the longer one, never "no auditor". A row
// whose status the app does not know counts as a reader, like an active one.
export function hasActiveAuditor(
  list:
    | {
        rows: readonly { status: string; unrecognized?: boolean }[]
        truncated: boolean
      }
    | undefined,
): boolean | undefined {
  if (!list) return undefined
  if (list.rows.some((row) => row.status === "active" || row.unrecognized)) {
    return true
  }
  return list.truncated ? undefined : false
}
