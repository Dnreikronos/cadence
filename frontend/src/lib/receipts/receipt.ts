import type { Role } from "@/lib/auth/guard"
import type { ClusterName } from "@/lib/solana/cluster"

// A Solana signature is base58. Anything else never becomes a link.
const base58Signature = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/

// Where a signature can be looked up on the cluster the app runs on. Null for a
// payment with no signature yet, or one that is not a signature at all.
export function explorerTxUrl(
  signature: string | null,
  cluster: ClusterName,
): string | null {
  if (!signature || !base58Signature.test(signature)) return null
  const base = `https://explorer.solana.com/tx/${signature}`
  return cluster === "mainnet" ? base : `${base}?cluster=${cluster}`
}

// The payment's counterparty is the other side of the viewer: a recipient is paid
// by the company, everyone else reads who the money went to.
export function counterpartyLabel(role: Role): "Paid by" | "Paid to" {
  return role === "recipient" ? "Paid by" : "Paid to"
}

// The date a receipt shows. The zone is named so a printed copy still means one thing.
export function formatPaidAt(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  })
}

// The day alone, for lists.
export function formatPaidDay(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  })
}

// Becomes the PDF's file name when the receipt is saved from the print dialog.
export function receiptTitle(
  counterpartyName: string,
  paidAt: string,
  timeZone?: string,
): string {
  const day = new Date(paidAt).toLocaleDateString("en-CA", { timeZone })
  return `Cadence receipt ${day} ${counterpartyName}`.trim()
}
