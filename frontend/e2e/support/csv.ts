import { readFile } from "node:fs/promises"
import { expect, type Download } from "@playwright/test"

// The columns of every export (docs/dev/API_CONTRACT.md, "CSV export"). A file may not
// carry more than these: an extra column would be data nobody agreed to export.
export const csvColumns = [
  "date",
  "counterparty",
  "amount",
  "status",
  "signature",
]

// RFC 4180: quoted fields, doubled quotes inside them, CRLF or LF line ends.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export async function readDownload(download: Download) {
  const path = await download.path()
  return {
    filename: download.suggestedFilename(),
    text: await readFile(path, "utf8"),
  }
}

// A payments export, strictly: the header line is exactly the documented columns, the
// file has the rows expected and nothing else, and every row has one cell per column, no
// more and no fewer (a stray column would be data nobody agreed to export).
//
// One deliberate deviation, kept loose until the contract settles: the amount. The
// contract (docs/dev/API_CONTRACT.md, "CSV export", still a draft) says a decimal USDC
// string with exactly six decimals, `4200.000000`; the mock answers `4200`, trimming the
// zeros (src/lib/api/mocks/handlers.ts, `csv()`). The lead decided not to change the mock
// yet, so the amount is only checked to be a decimal USDC amount, never base units: the
// callers compare its numeric value. Tighten the pattern to `\d+\.\d{6}` when the mock
// follows the contract.
export function expectPaymentsCsv(text: string, expectedRows: number) {
  const lines = text.split(/\r?\n/).filter((line) => line !== "")
  expect(lines[0], "the first line is the header").toBe(csvColumns.join(","))
  expect(lines, "one line per payment, after the header").toHaveLength(
    expectedRows + 1,
  )
  const rows = parseCsv(text)
  expect(rows[0]).toEqual(csvColumns)
  expect(rows).toHaveLength(expectedRows + 1)
  for (const row of rows) {
    expect(row, `cells of ${JSON.stringify(row)}`).toHaveLength(
      csvColumns.length,
    )
  }
  for (const [date, counterparty, amount, status] of rows.slice(1)) {
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(counterparty).not.toBe("")
    expect(amount).toMatch(/^\d{1,10}(\.\d{1,6})?$/)
    expect(["confirmed", "pending", "failed"]).toContain(status)
  }
  return rows
}
