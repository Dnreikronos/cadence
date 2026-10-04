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

// One line under the title: what kind of payment this is, without claiming
// that something was sent when it was not.
export function receiptSummary(payment: {
  status: "pending" | "confirmed" | "failed"
  transparent: boolean
}): string {
  if (payment.status === "pending") return "Waiting for the network to confirm."
  if (payment.status === "failed") return "This payment did not go through."
  return payment.transparent
    ? "Ordinary transfer, public on-chain."
    : "Encrypted transfer."
}

// Printed on a receipt from any build that is not real money, so a paper copy
// cannot pass for a real one. Null on mainnet with the real service.
export function testDataNotice(cluster: ClusterName, mock: boolean) {
  const parts = [
    ...(mock ? ["Mock data"] : []),
    ...(cluster === "mainnet" ? [] : ["Devnet: test funds"]),
  ]
  return parts.length ? parts.join(" · ") : null
}
