import { describe, expect, it } from "vitest"
import {
  counterpartyLabel,
  explorerTxUrl,
  formatPaidAt,
  formatPaidDay,
  receiptTitle,
} from "./receipt"

const signature = "5SigMockSignature1111111111111111111111111111"

describe("explorerTxUrl", () => {
  it("points devnet at the devnet cluster", () => {
    expect(explorerTxUrl(signature, "devnet")).toBe(
      `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    )
  })

  it("leaves the cluster off on mainnet", () => {
    expect(explorerTxUrl(signature, "mainnet")).toBe(
      `https://explorer.solana.com/tx/${signature}`,
    )
  })

  it("has no link for a payment that is not on the network yet", () => {
    expect(explorerTxUrl(null, "devnet")).toBeNull()
    expect(explorerTxUrl("", "devnet")).toBeNull()
  })

  it("never builds a link from something that is not a signature", () => {
    for (const bad of [
      `${signature}/../../evil`,
      `${signature}?cluster=custom&customUrl=http://evil.test`,
      "javascript:alert(1)",
      `${signature} `,
      "short",
      // base58 leaves out 0, O, I and l
      `0${signature.slice(1)}`,
    ]) {
      expect(explorerTxUrl(bad, "devnet"), bad).toBeNull()
    }
  })
})

describe("counterpartyLabel", () => {
  it("reads the company's side as paid to, the recipient's as paid by", () => {
    expect(counterpartyLabel("admin")).toBe("Paid to")
    expect(counterpartyLabel("auditor")).toBe("Paid to")
    expect(counterpartyLabel("recipient")).toBe("Paid by")
  })
})

describe("dates", () => {
  const iso = "2026-09-01T12:30:00Z"

  it("names the zone on a receipt", () => {
    expect(formatPaidAt(iso, "UTC")).toBe("Sep 1, 2026, 12:30 PM UTC")
  })

  it("follows the zone it is given, so a late payment keeps its own day", () => {
    expect(formatPaidDay("2026-09-01T02:00:00Z", "UTC")).toBe("Sep 1, 2026")
    expect(formatPaidDay("2026-09-01T02:00:00Z", "America/Sao_Paulo")).toBe(
      "Aug 31, 2026",
    )
  })

  it("titles the saved PDF with the day and the counterparty", () => {
    expect(receiptTitle("Bruno Costa", iso, "UTC")).toBe(
      "Cadence receipt 2026-09-01 Bruno Costa",
    )
  })
})
